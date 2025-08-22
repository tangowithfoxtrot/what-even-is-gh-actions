const core = require('@actions/core');
const exec = require('@actions/exec');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Determines the target architecture for the Rust binary
 */
function getArch() {
  const arch = process.arch;
  if (arch === 'x64') {
    return 'x86_64';
  } else if (arch === 'arm64') {
    return 'aarch64';
  } else {
    throw new Error(`Unsupported architecture: ${arch}`);
  }
}

/**
 * Determines the target platform for the Rust binary
 */
function getPlatform() {
  const platform = process.platform;
  if (platform === 'linux') {
    return 'unknown-linux-musl';
  } else if (platform === 'darwin') {
    return 'apple-darwin';
  } else if (platform === 'win32') {
    return 'pc-windows-msvc';
  } else {
    throw new Error(`Unsupported platform: ${platform}`);
  }
}

/**
 * Builds the Rust binary from source if needed
 */
async function buildFromSource(targetTriple) {
  core.info('Attempting to build the binary...');

  // It's easier to build for GNU than cross-compiling for MUSL
  if (targetTriple.includes('linux')) {
    targetTriple = `${getArch()}-unknown-linux-gnu`;
  }

  try {
    // Check if target is installed
    let targetOutput = '';
    await exec.exec('rustup', ['target', 'list', '--installed'], {
      listeners: {
        stdout: (data) => {
          targetOutput += data.toString();
        }
      }
    });

    if (!targetOutput.includes(targetTriple)) {
      core.info(`Target ${targetTriple} not found, adding it...`);
      await exec.exec('rustup', ['target', 'add', targetTriple]);
    }

    await exec.exec('cargo', ['build', '--release', '--target', targetTriple]);
  } catch (error) {
    throw new Error(`Failed to build sm-action for target: ${targetTriple}. ${error.message}`);
  }
}

/**
 * Finds the Rust binary or builds it if necessary
 */
async function getBinary() {
  const targetTriple = `${getArch()}-${getPlatform()}`;
  const binaryName = process.platform === 'win32' ? 'sm-action.exe' : 'sm-action';
  const binaryPath = path.join(__dirname, 'dist', targetTriple, binaryName);

  core.debug(`Looking for binary at: ${binaryPath}`);

  if (!fs.existsSync(binaryPath)) {
    core.warning(`No sm-action binary found for target: ${targetTriple}`);
    await buildFromSource(targetTriple);

    // After building, the binary should be in target/TRIPLE/release/
    const builtBinaryPath = path.join(__dirname, 'target', targetTriple, 'release', binaryName);
    if (fs.existsSync(builtBinaryPath)) {
      // Ensure dist directory exists
      const distDir = path.dirname(binaryPath);
      if (!fs.existsSync(distDir)) {
        fs.mkdirSync(distDir, { recursive: true });
      }
      // Copy the built binary to the expected location
      fs.copyFileSync(builtBinaryPath, binaryPath);
    } else {
      throw new Error(`Failed to build binary at ${builtBinaryPath}`);
    }
  }

  return binaryPath;
}

/**
 * Parses the secrets output from the Rust binary and sets GitHub Action outputs
 */
function parseAndSetOutputs(stdout) {
  const lines = stdout.split('\n');
  const outputs = {};

  for (const line of lines) {
    // Look for lines that indicate a secret was set
    const match = line.match(/Successfully wrote '([^']+)' to GITHUB_OUTPUT/);
    if (match) {
      const secretName = match[1];
      // The actual secret value would have been written to the GITHUB_OUTPUT file
      // by the Rust binary, but we also need to set it as an action output
      // We'll read it from the GITHUB_OUTPUT file if possible
      outputs[secretName] = '***'; // Placeholder - the actual value is in GITHUB_OUTPUT
    }
  }

  // Set outputs for the action
  for (const [key, value] of Object.entries(outputs)) {
    core.setOutput(key, value);
  }
}

/**
 * Main function
 */
async function run() {
  try {
    core.info('Setting up bitwarden/sm-action');

    // Set environment variables for the Rust binary
    const inputs = {
      'SM_ACCESS_TOKEN': core.getInput('access_token'),
      'SM_CLOUD_REGION': core.getInput('cloud_region'),
      'SM_SECRETS': core.getInput('secrets'),
      'SM_BASE_URL': core.getInput('base_url'),
      'SM_IDENTITY_URL': core.getInput('identity_url'),
      'SM_API_URL': core.getInput('api_url'),
      'SM_SET_ENV': core.getInput('set_env') || 'true'
    };

    // Validate required inputs
    if (!inputs.SM_ACCESS_TOKEN) {
      throw new Error('access_token is required');
    }
    if (!inputs.SM_SECRETS) {
      throw new Error('secrets is required');
    }

    // Set environment variables
    for (const [key, value] of Object.entries(inputs)) {
      if (value) {
        process.env[key] = value;
      }
    }

    // Get the binary path
    const binaryPath = await getBinary();
    core.debug(`Using binary: ${binaryPath}`);

    // Make sure the binary is executable
    if (process.platform !== 'win32') {
      fs.chmodSync(binaryPath, 0o755);
    }

    // Execute the Rust binary
    let stdout = '';
    let stderr = '';

    const exitCode = await exec.exec(binaryPath, [], {
      listeners: {
        stdout: (data) => {
          const output = data.toString();
          stdout += output;
          core.info(output.trim());
        },
        stderr: (data) => {
          const output = data.toString();
          stderr += output;
          core.error(output.trim());
        }
      }
    });

    if (exitCode !== 0) {
      throw new Error(`sm-action binary exited with code ${exitCode}. Error: ${stderr}`);
    }

    // Parse outputs and set them for the action
    parseAndSetOutputs(stdout);

    core.info('Successfully completed bitwarden/sm-action');

  } catch (error) {
    core.setFailed(error.message);
  }
}

// Run the action
if (require.main === module) {
  run();
}

module.exports = { run };
