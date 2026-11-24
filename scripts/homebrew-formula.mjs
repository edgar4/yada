import { readFileSync } from "node:fs";

const [version, sumsPath] = process.argv.slice(2);
const sums = Object.fromEntries(
  readFileSync(sumsPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => line.split(/\s+/).reverse()),
);
const asset = (target) => {
  const name = `yada-${target}.tar.gz`;
  if (!sums[name]) throw new Error(`Missing checksum for ${name}`);
  return `      url "https://github.com/edgar4/yada/releases/download/v${version}/${name}"
      sha256 "${sums[name]}"`;
};

process.stdout.write(`class Yada < Formula
  desc "Coding agent for your terminal"
  homepage "https://yada.edgar.co.ke"
  version "${version}"
  license "MIT"

  on_macos do
    on_arm do
${asset("darwin-arm64")}
    end
    on_intel do
${asset("darwin-x64")}
    end
  end

  on_linux do
    on_arm do
${asset("linux-arm64")}
    end
    on_intel do
${asset("linux-x64")}
    end
  end

  def install
    bin.install "yada"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/yada --version")
  end
end
`);
