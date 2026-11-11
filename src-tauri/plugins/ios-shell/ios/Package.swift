// swift-tools-version:5.3
import PackageDescription

let package = Package(
  name: "tauri-plugin-lightread-shell",
  platforms: [
    .macOS(.v10_13),
    .iOS(.v13),
  ],
  products: [
    .library(
      name: "tauri-plugin-lightread-shell",
      type: .static,
      targets: ["tauri-plugin-lightread-shell"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-lightread-shell",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
