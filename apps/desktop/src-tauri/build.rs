use std::path::PathBuf;

fn main() {
    copy_runtime_libs();
    tauri_build::build()
}

/// Copy the libmpv runtime libraries from `src-tauri/lib/` next to the built
/// binary. Tauri bundles `lib/**/*` as resources for release installs, but in
/// `tauri dev` nothing places them beside `target/<profile>/streamsync.exe`,
/// where `tauri-plugin-libmpv` looks for `libmpv-wrapper` + `libmpv-2`. This
/// step makes the embedded player work for plain `cargo`/`tauri dev` runs.
fn copy_runtime_libs() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let lib_dir = manifest_dir.join("lib");
    println!("cargo:rerun-if-changed=lib");
    if !lib_dir.is_dir() {
        return;
    }

    // OUT_DIR = target/<profile>/build/<pkg-hash>/out → profile dir is 3 up.
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let Some(profile_dir) = out_dir.ancestors().nth(3) else {
        return;
    };

    let Ok(entries) = std::fs::read_dir(&lib_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let src = entry.path();
        if !src.is_file() {
            continue;
        }
        let Some(name) = src.file_name() else { continue };
        let dst = profile_dir.join(name);
        // Skip if the dest is already up to date to avoid recopying the ~100MB
        // libmpv-2.dll on every build.
        let up_to_date = std::fs::metadata(&dst)
            .ok()
            .zip(std::fs::metadata(&src).ok())
            .map(|(d, s)| d.len() == s.len())
            .unwrap_or(false);
        if up_to_date {
            continue;
        }
        if let Err(e) = std::fs::copy(&src, &dst) {
            println!("cargo:warning=failed to copy {}: {e}", src.display());
        }
    }
}
