const { execSync } = require("node:child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");

/**
 * Gets the version from package.json
 */
function getVersion() {
  const packagePath = path.join(__dirname, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  return packageJson.version;
}

/**
 * Downloads a file from a URL to a local path
 */
function downloadFile(url, outputPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outputPath);

    const request = https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        // Handle redirect
        file.close();
        fs.unlinkSync(outputPath);
        request.destroy();
        downloadFile(response.headers.location, outputPath)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(outputPath);
        request.destroy();
        reject(new Error(`Failed to download: ${response.statusCode} ${response.statusMessage}`));
        return;
      }

      response.pipe(file);

      file.on('finish', () => {
        file.close();
        request.destroy();
        resolve();
      });

      file.on('error', (err) => {
        file.close();
        fs.unlinkSync(outputPath);
        request.destroy();
        reject(err);
      });
    });

    request.on('error', (err) => {
      file.close();
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
      }
      request.destroy();
      reject(err);
    });

    // Set a timeout to prevent hanging
    request.setTimeout(30000, () => {
      file.close();
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
      }
      request.destroy();
      reject(new Error('Download timeout'));
    });
  });
}

/**
 * Attempts to download the pre-built binary from GitHub Releases
 */
async function downloadBinary(targetTriple, binaryPath) {
  const version = getVersion();
  const releaseVersion = `${version}-bin`;

  // Construct the GitHub release URL
  const repoOwner = "tangowithfoxtrot"; // FIXME: update this later
  const repoName = "what-even-is-gh-actions"; // FIXME: update this later
  const assetName = `sm-action-${targetTriple}${
    process.platform === "win32" ? ".exe" : ""
  }`;
  const downloadUrl = `https://github.com/${repoOwner}/${repoName}/releases/download/${releaseVersion}/${assetName}`;

  console.log(`Attempting to download binary from: ${downloadUrl}`);

  try {
    // Ensure the directory exists
    const binaryDir = path.dirname(binaryPath);
    if (!fs.existsSync(binaryDir)) {
      fs.mkdirSync(binaryDir, { recursive: true });
    }

    await downloadFile(downloadUrl, binaryPath);
    console.log(`Successfully downloaded binary to: ${binaryPath}`);
    return true;
  } catch (error) {
    console.warn(`Failed to download binary: ${error.message}`);
    return false;
  }
}

/**
 * Determines the target architecture for the Rust binary
 */
function getArch() {
  const arch = process.arch;
  if (arch === "x64") {
    return "x86_64";
  } else if (arch === "arm64") {
    return "aarch64";
  } else {
    throw new Error(`Unsupported architecture: ${arch}`);
  }
}

/**
 * Determines the target platform for the Rust binary
 */
function getPlatform() {
  const platform = process.platform;
  if (platform === "linux") {
    return "unknown-linux-musl";
  } else if (platform === "darwin") {
    return "apple-darwin";
  } else if (platform === "win32") {
    return "pc-windows-msvc";
  } else {
    throw new Error(`Unsupported platform: ${platform}`);
  }
}

/**
 * Builds the Rust binary from source if needed
 */
async function buildFromSource(targetTriple) {
  // It's easier to build for GNU than cross-compiling for MUSL
  if (targetTriple.includes("linux")) {
    targetTriple = `${getArch()}-unknown-linux-gnu`;
  }

  // Check if target is installed
  const output = execSync("rustup target list --installed");
  const targetOutput = output.toString();

  if (!targetOutput.includes(targetTriple)) {
    execSync(`rustup target add ${targetTriple}`, { stdio: "inherit" });
  }

  execSync(`cargo build --release --target ${targetTriple}`, {
    stdio: "inherit",
  });
}

/**
 * Finds the Rust binary or builds it if necessary
 */
async function getBinary() {
  const targetTriple = `${getArch()}-${getPlatform()}`;
  const binaryName =
    process.platform === "win32" ? "sm-action.exe" : "sm-action";
  const binaryPath = path.join(
    __dirname,
    "target",
    targetTriple,
    "release",
    binaryName
  );

  console.debug(`Looking for binary at: ${binaryPath}`);

  if (!fs.existsSync(binaryPath)) {
    console.warn(`No sm-action binary found for target: ${targetTriple}`);

    // Try to download the pre-built binary first
    const downloadSuccess = await downloadBinary(targetTriple, binaryPath);

    if (!downloadSuccess) {
      console.log("Download failed, building from source...");
      await buildFromSource(targetTriple);

      // After building, the binary should be in target/TRIPLE/release/
      const builtBinaryPath = path.join(
        __dirname,
        "target",
        targetTriple,
        "release",
        binaryName
      );
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
  }

  return binaryPath;
}

/**
 * Main function
 */
async function run() {
  // Get the binary path
  const binaryPath = await getBinary();

  // Make sure the binary is executable
  if (process.platform !== "win32") {
    fs.chmodSync(binaryPath, 0o755);
  }

  execSync(binaryPath, { stdio: "inherit" });
}

run();
