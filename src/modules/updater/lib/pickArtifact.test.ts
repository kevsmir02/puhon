import { describe, expect, it } from "vitest";
import { pickArtifactUrl, type GhAsset } from "./pickArtifact";

const asset = (name: string, url = `https://github.com/x/${name}`): GhAsset => ({
  name,
  browser_download_url: url,
});

describe("pickArtifactUrl", () => {
  it("picks the x86_64 rpm for Dnf on x86_64", () => {
    const assets = [asset("Terax-0.9.0-1.x86_64.rpm"), asset("Terax-0.9.0-1.aarch64.rpm")];
    expect(pickArtifactUrl(assets, "dnf", "x86_64")).toBe(
      "https://github.com/x/Terax-0.9.0-1.x86_64.rpm",
    );
  });

  it("picks the aarch64 deb for Apt on arm64", () => {
    const assets = [asset("terax_0.9.0_amd64.deb"), asset("terax_0.9.0_arm64.deb")];
    expect(pickArtifactUrl(assets, "apt", "aarch64")).toBe(
      "https://github.com/x/terax_0.9.0_arm64.deb",
    );
  });

  it("returns null when nothing matches", () => {
    expect(pickArtifactUrl([asset("foo.txt")], "dnf", "x86_64")).toBeNull();
  });
});
