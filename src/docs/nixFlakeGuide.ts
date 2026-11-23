export const NIX_FLAKE_GUIDE_URI = 'sidemu://docs/nix-flake';

export const NIX_FLAKE_GUIDE_MD = `# Structuring a Nix \`flake.nix\` for Sidemu

Sidemu supports Nix flake workspaces automatically — **both with \`.envrc\` (\`direnv\`) and without \`.envrc\`**.

## How Sidemu Resolves Your Flake

In a **trusted** workspace, every refresh or boot resolves the environment lazily in this order:

1. **\`.envrc\` + \`direnv\`:** If \`.envrc\` exists and \`direnv\` is on \`PATH\`, Sidemu runs \`direnv export json\`.
2. **Automatic \`nix print-dev-env\` fallback (no \`.envrc\` required):** If \`flake.nix\` exists without \`.envrc\` (or without \`direnv\`), Sidemu runs \`nix print-dev-env --json\`, applies exported environment variables (\`ANDROID_HOME\`, \`ANDROID_SDK_ROOT\`, etc.), and prepends the flake's \`PATH\`. Results are cached by \`flake.nix\` / \`flake.lock\` mtime and invalidated on edits.
3. **Launch target auto-detection:** Sidemu inspects \`nix flake show --json\` and automatically adds \`apps.<system>.android-emulator\` to the sidebar dropdown and MCP \`boot_device\` tool (or use \`"sidemu.launchCommand": "nix run .#<app>"\` in \`.vscode/settings.json\` for another app name).

> **Note:** On NixOS/flake repos inside Git, \`flake.nix\` (and \`flake.lock\`) must be tracked in Git (\`git add flake.nix\`) for Nix to see them.

---

## 5 Rules for a Sidemu-Compatible \`flake.nix\`

1. **Export \`ANDROID_HOME\` pointing to \`\${sdk}/libexec/android-sdk\`:**
   Set \`ANDROID_HOME\` (and \`ANDROID_SDK_ROOT\`) as top-level attributes on \`pkgs.mkShell\`, and include \`platform-tools\` in \`packages\` so \`\$ANDROID_HOME/platform-tools/adb\` exists.
   Import \`nixpkgs\` with \`allowUnfree = true; android_sdk.accept_license = true;\`.
2. **Keep \`adb\` versions identical between \`devShells\` and the emulator app:**
   Share the same \`composeAndroidPackages\` derivation (or \`emulator.platformTools\`) so the \`adb\` client in \`devShells.default\` matches the \`adb\` server started by the emulator wrapper.
3. **Gate headless flags on \`SIDEMU_ACTIVE=1\`:**
   Inside VSCodium / VS Code, Sidemu sets \`SIDEMU_ACTIVE=1\`. Append \`-no-window -no-audio -no-boot-anim\` when \`SIDEMU_ACTIVE=1\` so the emulator runs headlessly inside the Sidemu sidebar, while still opening a normal GUI window if run outside the IDE.
4. **Use a writable host directory for AVD state:**
   \`/nix/store\` is read-only. Set \`ANDROID_AVD_HOME="\${XDG_CACHE_HOME:-\$HOME/.cache}/nix-avd/<name>"\` and auto-create the AVD via \`avdmanager\` if missing.
5. **Start the ADB server & export GPU libraries before \`exec emulator\`:**
   Run \`adb start-server >/dev/null 2>&1 || true\` before \`exec emulator\`, and on Linux include \`pkgs.vulkan-loader\` and \`pkgs.libGL\` in \`LD_LIBRARY_PATH\`.

---

## Template 1: Using \`sidemu.lib.mkSidebarEmulator\` (Recommended)

\`\`\`nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    sidemu.url = "github:fumoctl/SideEmu";
  };

  outputs = { self, nixpkgs, sidemu }:
    let
      system = "x86_64-linux"; # or aarch64-linux
      pkgs = nixpkgs.legacyPackages.\${system};
      emulator = sidemu.lib.mkSidebarEmulator {
        inherit system;
        name = "pixel";
        platformVersion = "34";
      };
    in
    {
      apps.\${system}.android-emulator = {
        type = "app";
        program = "\${emulator}/bin/sidemu-emulator";
      };

      devShells.\${system}.default = pkgs.mkShell {
        packages = [ emulator.platformTools ];
        ANDROID_HOME = "\${emulator.platformTools}/libexec/android-sdk";
        ANDROID_SDK_ROOT = "\${emulator.platformTools}/libexec/android-sdk";
      };
    };
}
\`\`\`

---

## Template 2: Standalone \`flake.nix\` (Only \`nixpkgs\` Input)

Use this when you do not want to add \`sidemu\` as a flake input:

\`\`\`nix
{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAll = f: nixpkgs.lib.genAttrs systems f;
      pkgsFor = system: import nixpkgs {
        inherit system;
        config = {
          allowUnfree = true;
          android_sdk.accept_license = true;
        };
      };
      androidFor = pkgs: pkgs.androidenv.composeAndroidPackages {
        platformVersions = [ "34" ];
        includeEmulator = true;
        includeSystemImages = true;
        systemImageTypes = [ "google_apis" ];
        abiVersions = [ (if pkgs.stdenv.hostPlatform.isAarch64 then "arm64-v8a" else "x86_64") ];
        includeNDK = false;
      };
    in
    {
      packages = forAll (system:
        let
          pkgs = pkgsFor system;
          android = androidFor pkgs;
          sdk = android.androidsdk;
          abi = if pkgs.stdenv.hostPlatform.isAarch64 then "arm64-v8a" else "x86_64";
          gpuLibs = pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux
            (pkgs.lib.makeLibraryPath [ pkgs.vulkan-loader pkgs.libGL ]);
        in
        {
          android-emulator = pkgs.writeShellApplication {
            name = "android-emulator";
            runtimeInputs = [ sdk pkgs.coreutils ];
            text = ''
              export ANDROID_SDK_ROOT="\${sdk}/libexec/android-sdk"
              export ANDROID_HOME="\$ANDROID_SDK_ROOT"
              export ANDROID_AVD_HOME="''\${XDG_CACHE_HOME:-\$HOME/.cache}/nix-avd/app"
              export ANDROID_USER_HOME="\$ANDROID_AVD_HOME/user-home"
              mkdir -p "\$ANDROID_AVD_HOME" "\$ANDROID_USER_HOME"

              if [ ! -f "\$ANDROID_AVD_HOME/app.ini" ]; then
                avdmanager create avd --force --name "app" \\
                  --package "system-images;android-34;google_apis;\${abi}" \\
                  --device "pixel_6" <<< "no"
                echo "hw.keyboard=yes" >> "\$ANDROID_AVD_HOME/app.avd/config.ini"
              fi

              \${pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
                export LD_LIBRARY_PATH="\${gpuLibs}''\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}"
              ''}

              adb start-server >/dev/null 2>&1 || true

              args=(-avd "app" -gpu "auto")
              if [ "''\${SIDEMU_ACTIVE:-}" = "1" ]; then
                args+=(-no-window -no-audio -no-boot-anim)
              fi
              exec emulator "''\${args[@]}" "\$@"
            '';
          };
        });

      apps = forAll (system: {
        android-emulator = {
          type = "app";
          program = "\${self.packages.\${system}.android-emulator}/bin/android-emulator";
        };
      });

      devShells = forAll (system:
        let
          pkgs = pkgsFor system;
          platformTools = (androidFor pkgs).platform-tools;
        in
        {
          default = pkgs.mkShell {
            packages = [ platformTools ];
            ANDROID_HOME = "\${platformTools}/libexec/android-sdk";
            ANDROID_SDK_ROOT = "\${platformTools}/libexec/android-sdk";
          };
        });
    };
}
\`\`\`

---

## Template 3: ADB-Only Flake (Physical Devices or Host AVDs)

\`\`\`nix
{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs {
        inherit system;
        config = {
          allowUnfree = true;
          android_sdk.accept_license = true;
        };
      };
      platformTools = (pkgs.androidenv.composeAndroidPackages {
        platformVersions = [ ];
        includeEmulator = false;
        includeSystemImages = false;
        includeNDK = false;
      }).platform-tools;
    in
    {
      devShells.\${system}.default = pkgs.mkShell {
        packages = [ platformTools ];
        ANDROID_HOME = "\${platformTools}/libexec/android-sdk";
        ANDROID_SDK_ROOT = "\${platformTools}/libexec/android-sdk";
      };
    };
}
\`\`\`

> **Tip:** If your flake uses standalone \`pkgs.android-tools\` (which provides \`bin/adb\` without a \`platform-tools/\` directory), do **not** set \`ANDROID_HOME\` to it — leave \`ANDROID_HOME\` unset so \`mobilecli\` resolves \`adb\` from \`PATH\`.

---

## \`.envrc\` vs No-\`.envrc\`

- **Without \`.envrc\`:** Sidemu automatically calls \`nix print-dev-env --json\`, so sidebar discovery, \`mobilecli\`, and MCP tools work immediately.
- **With \`.envrc\` (\`use flake\`):** Recommended when you also want \`adb\`/\`emulator\` on \`PATH\` inside integrated terminals and faster \`nix-direnv\` caching.
`;
