// Prevents additional console window on Windows in release, DO NOT REMIFY!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    zex_lib::run()
}
