export type GhAsset = { name: string; browser_download_url: string };
export type PackageManager = "dnf" | "apt";

const RPM_ARCH: Record<string, string> = {
  x86_64: "x86_64",
  aarch64: "aarch64",
};

const DEB_ARCH: Record<string, string> = {
  x64: "amd64",
  x86_64: "amd64",
  aarch64: "arm64",
  arm64: "arm64",
};

export function pickArtifactUrl(
  assets: GhAsset[],
  pm: PackageManager,
  arch: string,
): string | null {
  const ext = pm === "dnf" ? ".rpm" : ".deb";
  const map = pm === "dnf" ? RPM_ARCH : DEB_ARCH;
  const archToken = map[arch] ?? arch;
  const match = assets.find(
    (a) => a.name.endsWith(ext) && a.name.includes(archToken),
  );
  return match ? match.browser_download_url : null;
}
