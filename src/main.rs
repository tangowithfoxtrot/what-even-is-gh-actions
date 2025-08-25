use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::str::FromStr;

use anyhow::Result;
use bitwarden_core::auth::login::AccessTokenLoginRequest;
use bitwarden_core::{Client, ClientSettings};
use bitwarden_sm::ClientSecretsExt;
use bitwarden_sm::secrets::SecretsGetRequest;

use config::{Config, get_env, infer_urls};
use uuid::Uuid;

mod config;

#[tokio::main]
async fn main() -> Result<()> {
    // --test arg to validate the binaries in CI
    if std::env::args().any(|arg| arg == "--test") {
        println!("success");
        return Ok(());
    }

    let config = Config::new()?;
    let (api_url, identity_url) = infer_urls(&config)?;

    let client = Client::new(Some(ClientSettings {
        identity_url,
        api_url,
        user_agent: "bitwarden/sm-action".to_string(),
        device_type: bitwarden_core::DeviceType::SDK,
    }));

    println!("Parsing secrets input...");
    let id_to_name_map = parse_secret_input(config.secrets).map_err(|_| {
        anyhow::anyhow!("Failed to parse secrets input. Ensure the format is 'UUID > Name'.")
    })?;

    println!("Authenticating with Bitwarden...");
    let auth_result = client
        .auth()
        .login_access_token(&AccessTokenLoginRequest {
            access_token: config.access_token,
            state_file: None,
        })
        .await;

    if let Err(e) = auth_result {
        return Err(anyhow::anyhow!(
            "Authentication with Bitwarden failed.\nError: {}",
            e.to_string()
        ));
    }

    let secret_ids: Vec<Uuid> = id_to_name_map.keys().cloned().collect();

    let secrets = client
        .secrets()
        .get_by_ids(SecretsGetRequest { ids: secret_ids })
        .await.map_err(|e| {
            anyhow::anyhow!(
                "The secrets provided could not be found. Please check the machine account has access to the secret UUIDs provided.\nError: {}",
                e.to_string()
            )
        })?;

    let secret_envs = prepare_secret_env_vars(&secrets.data, &id_to_name_map);

    if let Some(run_cmd) = &config.run {
        execute_run_command(run_cmd, secret_envs)?;
    } else {
        for (name, value) in secret_envs.iter() {
            println!("Setting secret: {name}");
            set_secrets(name, value)?;
        }
    }

    Ok(())
}

/// Parses the secret input from the GitHub Actions environment variable.
fn parse_secret_input(secret_lines: Vec<String>) -> Result<HashMap<Uuid, String>> {
    let mut map: HashMap<Uuid, String> = HashMap::with_capacity(secret_lines.capacity());

    for line in secret_lines.iter() {
        debug!("Parsing line: {line}");
        let uuid_part = line.split('>').next().unwrap_or_default().trim();
        let uuid = Uuid::from_str(uuid_part)
            .map_err(|_| anyhow::anyhow!("Invalid UUID format: {uuid_part}"))?;

        let desired_name = line.split('>').nth(1).unwrap_or_default().trim();

        if let Some(old_value) = map.insert(uuid, desired_name.to_string()) {
            eprintln!(
                "Warning: Duplicate UUID found: {uuid}. Old value: {old_value}, New value: {desired_name}"
            );
        }
    }

    Ok(map)
}

/// Masks a value in the GitHub Actions logs to prevent it from being displayed.
fn mask_value(value: &str) {
    println!("::add-mask::{value}");
}

fn issue_file_command(mut file: std::fs::File, key: &str, value: &str) -> Result<()> {
    let delimiter = format!("ghadelimiter_{}", uuid::Uuid::new_v4());
    writeln!(
        file,
        r#"{key}<<{delimiter}
{value}
{delimiter}"#
    )?;
    file.flush()?; // ensure the data is written to disk
    Ok(())
}

/// Sets a secret in the GitHub Actions environment.
fn set_secrets(secret_name: &str, secret_value: &str) -> Result<()> {
    mask_value(secret_value);

    let env_path = get_env("GITHUB_ENV").unwrap_or("/dev/null".to_owned());
    debug!("Writing to GITHUB_ENV: {env_path}");
    let env_file = OpenOptions::new()
        .create(true) // needed for unit tests
        .append(true)
        .open(&env_path)?;

    issue_file_command(env_file, secret_name, secret_value)?;
    debug!("Successfully wrote '{secret_name}' to GITHUB_ENV");

    // Cannot set GITHUB_OUTPUT dynamically in composite actions: https://github.com/actions/runner/issues/2515

    Ok(())
}

/// Executes a run command with the provided secrets as environment variables.
fn execute_run_command(run_cmd: &str, secret_envs: HashMap<String, String>) -> Result<()> {
    if run_cmd.trim().is_empty() {
        return Ok(());
    }

    let shell = match std::env::consts::OS {
        "windows" => "powershell",
        _ => "/bin/sh", // should be safe for any POSIX OS
    };

    let status = std::process::Command::new(shell)
        .arg("-c")
        .arg(run_cmd)
        .envs(secret_envs)
        .status();

    match status {
        Ok(exit_status) if exit_status.success() => {
            debug!("Commands executed successfully.");
            Ok(())
        }
        Ok(exit_status) => Err(anyhow::anyhow!(
            "Commands exited with non-zero status: {}",
            exit_status
        )),
        Err(e) => Err(anyhow::anyhow!("Failed to execute commands: {}", e)),
    }
}

/// Converts secrets data into environment variables based on the ID to name mapping.
fn prepare_secret_env_vars(
    secrets_data: &[bitwarden_sm::secrets::SecretResponse],
    id_to_name_map: &HashMap<Uuid, String>,
) -> HashMap<String, String> {
    secrets_data
        .iter()
        .filter_map(|secret| {
            id_to_name_map
                .get(&secret.id)
                .map(|name| (name.clone(), secret.value.clone()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_set_secrets() {
        let secret_name = "TEST_SECRET";
        let secret_value = r#"BrowserSettings__EnvironmentUrl=https://example.com

    # Browser Settings 2
    BrowserSettings__EnvironmentUrl=https://example2.com"#;

        // Create temporary files for testing
        let temp_dir = std::env::temp_dir();
        let env_path = temp_dir.join(format!("github_env_test_{}", uuid::Uuid::new_v4()));

        // Set environment variables to point to our temp files
        unsafe {
            std::env::set_var("GITHUB_ENV", &env_path);
        }

        // Run the function
        set_secrets(secret_name, secret_value).unwrap();

        // Check if the file was created and contains the expected values
        let env_content = std::fs::read_to_string(&env_path).unwrap();

        assert!(env_content.contains(&format!("{secret_name}<<ghadelimiter_")));
        assert!(env_content.contains(&secret_value));

        // Clean up temp files
        let _ = std::fs::remove_file(&env_path);
    }

    #[test]
    fn test_parse_secret_lines() {
        let id_to_name_map = parse_secret_input(vec![
            "91ba3f10-a9a2-4795-bacf-0eee2d39a074 > ONE".to_string(),
            "bfd7aa33-54f2-487b-bbbf-4a69b49fdc0d > TWO".to_string(),
        ])
        .unwrap();

        assert_eq!(id_to_name_map.len(), 2);
        assert_eq!(
            id_to_name_map.get(&Uuid::from_str("91ba3f10-a9a2-4795-bacf-0eee2d39a074").unwrap()),
            Some(&"ONE".to_string())
        );

        assert_eq!(
            id_to_name_map.get(&Uuid::from_str("bfd7aa33-54f2-487b-bbbf-4a69b49fdc0d").unwrap()),
            Some(&"TWO".to_string())
        );
    }

    #[test]
    fn test_parse_secret_lines_two() {
        let id_to_name_map = parse_secret_input(vec![
            "91ba3f10-a9a2-4795-bacf-0eee2d39a074 > ONE".to_string(),
            "91ba3f10-a9a2-4795-bacf-0eee2d39a074 > TWO".to_string(),
        ])
        .unwrap();

        assert_eq!(id_to_name_map.len(), 1); // We expect only one entry since the UUID is the same

        assert_eq!(
            id_to_name_map.get(&Uuid::from_str("91ba3f10-a9a2-4795-bacf-0eee2d39a074").unwrap()),
            Some(&"TWO".to_string())
        );
    }

    #[test]
    fn test_parse_secret_lines_invalid_uuid() {
        let id_to_name_map = parse_secret_input(vec![
            "invalid-uuid > INVALID".to_string(),
            "91ba3f10-a9a2-4795-bacf-0eee2d39a074 > VALID".to_string(),
        ]);

        assert!(id_to_name_map.is_err());
    }

    #[test]
    fn test_execute_run_command_success() {
        let mut env_vars = HashMap::new();
        env_vars.insert("SECRET1".to_string(), "value1".to_string());
        env_vars.insert("SECRET2".to_string(), "value2".to_string());

        // Test with a simple command that should succeed
        let result = execute_run_command("echo 'Hello World'", env_vars);
        assert!(result.is_ok());
    }

    #[test]
    fn test_execute_run_command_failure() {
        let env_vars = HashMap::new();

        // Test with a command that should fail
        let result = execute_run_command("exit 1", env_vars);
        assert!(result.is_err());
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("Commands exited with non-zero status")
        );
    }

    #[test]
    fn test_execute_run_command_empty_command() {
        let env_vars = HashMap::new();

        let result = execute_run_command("", env_vars);
        assert!(result.is_ok());

        let env_vars2 = HashMap::new();
        let result = execute_run_command("   ", env_vars2);
        assert!(result.is_ok());
    }
}
