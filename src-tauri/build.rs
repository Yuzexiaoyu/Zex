fn main() {
    println!("cargo:rerun-if-changed=7zip/7za.exe");
    assert!(
        std::path::Path::new("7zip/7za.exe").is_file(),
        "Missing embedded 7-Zip: run scripts/fetch-7zip.sh before building"
    );
    tauri_build::build()
}
