# Sidemu

Run and mirror **Android emulators, iOS simulators, and physical mobile devices** directly inside a **VSCodium / VS Code Sidebar Webview** (draggable to the Secondary Sidebar), with zero external CLI installs, an **embedded Streamable HTTP MCP server** for AI agents, and first-class **Nix flake / `direnv`** support.

## Features

- **Zero-install `.vsix` packaging:** Bundles `mobilecli` v1.0.23 directly in `bin/` (verified by SHA-256) and bundles the extension host + `@modelcontextprotocol/sdk` + `zod` into `dist/extension.js` with `esbuild`. No `npm install -g` or `npx` downloads required at runtime.
- **VSCodium-safe live video mirroring:** Streams MJPEG frames from `mobilecli` through an authenticated localhost bridge to `<canvas>` inside the Sidebar Webview (no H.264 / proprietary codecs required).
- **Interactive input & platform-aware toolbar:** Normalized pointer taps, long presses, swipes, keyboard typing, special keys, and hardware buttons (`Home`, `Power`, `Vol+`, `Vol-`, plus Android-only `Back` and `App Switch`).
- **Live AI agent overlay:** Displays animated ripples/trails with an `AI` badge on the device canvas when an AI agent calls `tap` or `swipe` through the MCP server.
- **Seamless terminal interception:** Sets `SIDEMU_ACTIVE=1` (`VSCODIUM_ANDROID_SIDEBAR=1`) in integrated terminals and prepends `shim/` to `PATH` so `emulator -avd ...` automatically runs headlessly (`-no-window`) inside the IDE and auto-focuses the sidebar when ready.
- **Pure-TypeScript ADB tracker & macOS iOS poller:** Watches `127.0.0.1:5037` (`host:track-devices`) without `adb` version mismatches, and polls `mobilecli devices` for iOS Simulators/devices on macOS.
- **Zero telemetry:** Passes `MOBILEMCP_DISABLE_TELEMETRY=1` to all spawned `mobilecli` and emulator processes.

<!-- Add screenshots here once captured from a live emulator/simulator session -->

## Commands & Settings

### Commands

| Command | Description |
| --- | --- |
| `Sidemu: Boot Device…` | Pick an offline Android AVD, iOS Simulator, or Nix flake target to boot headlessly |
| `Sidemu: Shut Down Active Device` | Shut down the currently active emulator or simulator |
| `Sidemu: Refresh Devices` | Re-resolve environment (`direnv` / Nix), launch targets, and connected devices |
| `Sidemu: Save Screenshot` | Save a PNG screenshot from the active device |
| `Sidemu: Copy MCP Server Config` | Copy an HTTP MCP client config snippet (VS Code, Antigravity, or generic) |
| `Sidemu: Show Logs` | Open the Sidemu output channel |

### Settings

| Setting | Default | Description |
| --- | --- | --- |
| `sidemu.mobilecliPath` | `""` | Optional override path to `mobilecli` (defaults to bundled `bin/mobilecli`) |
| `sidemu.androidHome` | `""` | Optional Android SDK root override (auto-discovers `~/.local/share/Android[/Sdk]` and `~/Android/Sdk`) |
| `sidemu.avdHome` | `""` | Optional Android AVD directory override (auto-discovers `~/.config/.android/avd` and `~/.android/avd`) |
| `sidemu.launchCommand` | `""` | Workspace command to launch an emulator (e.g., `"nix run .#emulator"`) in trusted workspaces |
| `sidemu.mcpPort` | `45821` | Localhost port for the embedded MCP server (falls back to a free port if occupied) |
| `sidemu.autoFocus` | `true` | Auto-focus the Sidemu sidebar and attach when a device comes online |
| `sidemu.streamQuality` | `70` | MJPEG JPEG quality (`1`–`100`) |
| `sidemu.streamScale` | `0.5` | MJPEG scale factor (`0.1`–`1`) |
| `sidemu.useDirenv` | `true` | Evaluate `direnv export json` (or fall back to `nix print-dev-env` for flakes without `.envrc`) in trusted workspaces |
| `sidemu.shutdownOnExit` | `true` | Best-effort shutdown of emulators/simulators booted by Sidemu on deactivation |

## Embedded MCP Server

Sidemu hosts a Streamable HTTP MCP server at `http://127.0.0.1:45821/mcp` (or the port shown in the sidebar's `MCP:` pill) and registers with `vscode.lm.registerMcpServerDefinitionProvider` when available.

### Exposed MCP Tools

**Device & App Lifecycle**
- `list_devices` — Lists online/offline Android emulators, iOS simulators (macOS), physical devices, and Nix launch targets
- `boot_device` — Focuses the sidebar, boots an AVD, iOS simulator, or Nix launch target headlessly, and attaches the stream
- `shutdown_device` — Shuts down a running emulator/simulator
- `install_app` — Installs an Android `.apk` or iOS `.app` / `.ipa` (with optional iOS re-signing)
- `uninstall_app` — Uninstalls an app by Android package name or iOS bundle ID
- `launch_app` — Launches an installed app by package name / bundle ID (with optional Android `activity` or `locales`)
- `terminate_app` — Force-stops / terminates a running app
- `clear_app_data` — Clears persisted app data and cache for a package name / bundle ID

**Inspection, Gestures, Screen Controls & Batching**
- `get_screenshot` — Returns a downscaled JPEG screenshot image block plus coordinate dimensions
- `get_ui_elements` — Returns a compact accessibility snapshot with `@eN` refs cached for instant ref-based interactions
- `tap` — Taps at `(x, y)`, `@ref`, or matching `text`, drawing a live `AI` ripple overlay
- `double_tap` — Double-taps at `(x, y)`, `@ref`, or `text`, drawing live `AI` ripple overlays
- `long_press` — Presses and holds at `(x, y)`, `@ref`, or `text`, drawing a live `AI` hold overlay
- `swipe` — Swipes by coordinates or direction (optionally inside a container `@ref` or `text`), drawing a live `AI` trail overlay
- `drag` — Holds and drags from `(x1, y1)` / `fromRef` / `fromText` to `(x2, y2)` / `toRef` / `toText`, drawing a live `AI` trail overlay
- `type_text` — Types text into the focused field (with optional `submit`)
- `press_key` — Presses `HOME`, `POWER`, `VOLUME_UP`, `VOLUME_DOWN`, `ENTER`, `BACKSPACE`, or Android-only `BACK` / `APP_SWITCH`
- `get_orientation` / `set_orientation` — Reads or switches screen orientation (`portrait` / `landscape`)
- `start_screen_recording` / `stop_screen_recording` — Starts and finalizes MP4 screen recordings on the host
- `batch_actions` — Executes a multi-step sequence of gestures, `@ref` clicks, typing, app controls, waits, snapshots, and screenshots in one tool call
- `open_url` — Opens a URL or deep link on the active device
- `get_crash_logs` — Fetches recent crash reports for the active device
- `get_nix_flake_guide` — Returns documentation & templates for structuring a Nix `flake.nix` for Sidemu (also exposed as MCP resource `sidemu://docs/nix-flake` and prompt `setup_nix_flake`)

### Client Snippets

**VS Code / VSCodium (`.vscode/mcp.json`):**

```json
{
  "servers": {
    "sidemu": {
      "type": "http",
      "url": "http://127.0.0.1:45821/mcp"
    }
  }
}
```

**Antigravity (`~/.gemini/config/mcp_config.json`):**

```json
{
  "mcpServers": {
    "sidemu": {
      "serverUrl": "http://127.0.0.1:45821/mcp"
    }
  }
}
```

**Generic `mcpServers` (Cursor / Claude / etc.):**

```json
{
  "mcpServers": {
    "sidemu": {
      "type": "http",
      "url": "http://127.0.0.1:45821/mcp"
    }
  }
}
```

## Nix Flake & `direnv` Integration

Sidemu never caches `PATH`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, or `ANDROID_AVD_HOME` at activation time. In trusted workspaces, every refresh or boot resolves the environment lazily:

1. **`.envrc` + `direnv`:** Runs `direnv export json` when `.envrc` and `direnv` are present.
2. **Automatic `nix print-dev-env` fallback (no `.envrc` required):** When `flake.nix` exists without `.envrc` (or without `direnv`), Sidemu runs `nix print-dev-env --json`, applies exported variables (`ANDROID_HOME`, `ANDROID_SDK_ROOT`, etc.), and prepends the flake's `PATH` (cached by `flake.nix` / `flake.lock` mtime).
3. **Launch target auto-detection:** Detects `apps.<system>.android-emulator` via `nix flake show --json` (or use `"sidemu.launchCommand": "nix run .#<app>"` for a custom app name).

### 5 Rules for Structuring Any `flake.nix` for Sidemu

1. **Set `ANDROID_HOME = "${sdk}/libexec/android-sdk"` (and `ANDROID_SDK_ROOT`) on `pkgs.mkShell`**, and include `platform-tools` so `$ANDROID_HOME/platform-tools/adb` exists (`nixpkgs` must be imported with `allowUnfree = true; android_sdk.accept_license = true;`).
   *(If you use standalone `pkgs.android-tools`, which has no `platform-tools/` folder, leave `ANDROID_HOME` unset so `mobilecli` resolves `adb` from `PATH`.)*
2. **Use the exact same `adb` version** in `devShells.default` and the emulator app (share the same `composeAndroidPackages` result or `emulator.platformTools`).
3. **Gate headless mode on `SIDEMU_ACTIVE=1`:** Pass `-no-window -no-audio -no-boot-anim` when `SIDEMU_ACTIVE=1` so the emulator streams headlessly in the sidebar inside VSCodium/VS Code and opens a normal GUI window outside the IDE.
4. **Store AVDs in a writable host directory** (e.g., `${XDG_CACHE_HOME:-$HOME/.cache}/nix-avd/<name>`) since `/nix/store` is read-only.
5. **Run `adb start-server >/dev/null 2>&1 || true`** before `exec emulator`, and on Linux add `vulkan-loader` and `libGL` to `LD_LIBRARY_PATH`.

> **Note:** When your workspace is a Git repository, stage `flake.nix` (`git add flake.nix`) so Nix flake evaluation sees it.

### Option A: Using `sidemu.lib.mkSidebarEmulator` (Recommended)

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    sidemu.url = "github:fumoctl/SideEmu";
  };

  outputs = { self, nixpkgs, sidemu }:
    let
      system = "x86_64-linux"; # or aarch64-linux
      pkgs = nixpkgs.legacyPackages.${system};
      emulator = sidemu.lib.mkSidebarEmulator {
        inherit system;
        name = "pixel";
        platformVersion = "34";
      };
    in
    {
      apps.${system}.android-emulator = {
        type = "app";
        program = "${emulator}/bin/sidemu-emulator";
      };

      devShells.${system}.default = pkgs.mkShell {
        packages = [ emulator.platformTools ];
        ANDROID_HOME = "${emulator.platformTools}/libexec/android-sdk";
        ANDROID_SDK_ROOT = "${emulator.platformTools}/libexec/android-sdk";
      };
    };
}
```

### Option B: Standalone `flake.nix` (Only `nixpkgs` Input)

```nix
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
              export ANDROID_SDK_ROOT="${sdk}/libexec/android-sdk"
              export ANDROID_HOME="$ANDROID_SDK_ROOT"
              export ANDROID_AVD_HOME="''${XDG_CACHE_HOME:-$HOME/.cache}/nix-avd/app"
              export ANDROID_USER_HOME="$ANDROID_AVD_HOME/user-home"
              mkdir -p "$ANDROID_AVD_HOME" "$ANDROID_USER_HOME"

              if [ ! -f "$ANDROID_AVD_HOME/app.ini" ]; then
                avdmanager create avd --force --name "app" \
                  --package "system-images;android-34;google_apis;${abi}" \
                  --device "pixel_6" <<< "no"
                echo "hw.keyboard=yes" >> "$ANDROID_AVD_HOME/app.avd/config.ini"
              fi

              ${pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
                export LD_LIBRARY_PATH="${gpuLibs}''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
              ''}

              adb start-server >/dev/null 2>&1 || true

              args=(-avd "app" -gpu "auto")
              if [ "''${SIDEMU_ACTIVE:-}" = "1" ]; then
                args+=(-no-window -no-audio -no-boot-anim)
              fi
              exec emulator "''${args[@]}" "$@"
            '';
          };
        });

      apps = forAll (system: {
        android-emulator = {
          type = "app";
          program = "${self.packages.${system}.android-emulator}/bin/android-emulator";
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
            ANDROID_HOME = "${platformTools}/libexec/android-sdk";
            ANDROID_SDK_ROOT = "${platformTools}/libexec/android-sdk";
          };
        });
    };
}
```

> AI agents connected to Sidemu's MCP server can also fetch these templates anytime via `get_nix_flake_guide`, resource `sidemu://docs/nix-flake`, or prompt `setup_nix_flake`.

## Terminal Shim, Traditional SDK & iOS Behavior

- On Unix (`Linux` / `macOS`), Sidemu prepends `shim/` to integrated terminal `PATH` and sets `SIDEMU_ACTIVE=1`. Running `emulator -avd <name>` inside an IDE terminal automatically passes `-no-window`, and Sidemu focuses the sidebar once the device comes online.
- **Traditional Android SDK & XDG AVD Discovery (including NixOS):** Sidemu auto-discovers Android SDKs under `$XDG_DATA_HOME/Android[/Sdk]` and `~/Android[/Sdk]` and AVDs under `$XDG_CONFIG_HOME/.android/avd` and `~/.android/avd`. On NixOS, unpatched traditional SDK binaries (`adb`, `emulator`) are automatically wrapped via `nix-alien` (FHS env) when available on the host.
- On macOS, `mobilecli device boot` / `xcrun simctl boot` starts iOS Simulators headlessly without launching `Simulator.app`.

## Development & Packaging

```sh
direnv allow
npm install
npm run build           # Fetches host mobilecli v1.0.23 and builds dist/
npm run package:host    # Builds dist-vsix/sidemu-<host>-0.1.0.vsix
npm run package:all     # Builds all 6 platform .vsix targets
```

CI builds all 6 platform targets and publishes tagged releases (`v*`) to Open VSX via `.github/workflows/release.yml` using the `OVSX_PAT` repository secret.

## Licensing

- **Sidemu** extension source code is licensed under the **MIT License**.
- **Bundled `mobilecli` v1.0.23** (in `bin/`) is licensed under the **Functional Source License, Version 1.1, ALv2 Future License (FSL-1.1-ALv2)**, Copyright 2025-2026 Mobile Next HQ, Inc. See [`LICENSE`](LICENSE) for full terms.

## Known Limitations

- Video streaming uses MJPEG only (compatible with VSCodium without proprietary H.264/WebCodecs codecs).
- Terminal `emulator` PATH shimming is POSIX-only (Windows terminals do not inject `-no-window` automatically).
