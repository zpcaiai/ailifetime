#!/usr/bin/env bash
set -euo pipefail

sdk_dir="$(cd "$(dirname "$0")" && pwd)"
build_dir="$(mktemp -d "${TMPDIR:-/tmp}/ltm-sdk-java.XXXXXX")"
trap 'rm -rf -- "$build_dir"' EXIT

find "$sdk_dir/src/main/java" "$sdk_dir/src/test/java" -name '*.java' -print0 \
  | xargs -0 javac --release 17 --add-modules jdk.httpserver -Xlint:all -Werror -d "$build_dir"
java --add-modules jdk.httpserver -cp "$build_dir" com.ailifetime.sdk.ContractTest
