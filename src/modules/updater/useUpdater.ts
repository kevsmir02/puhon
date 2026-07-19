import { getVersion } from "@tauri-apps/api/app";
import { arch } from "@tauri-apps/plugin-os";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useCallback, useEffect, useState } from "react";
import {
  pickArtifactUrl,
  type GhAsset,
  type PackageManager,
} from "./lib/pickArtifact";
import {
  updaterDetect,
  updaterDownload,
  updaterInstall,
  type DetectResult,
  type DownloadEvent,
} from "@/lib/native";

const LAST_CHECK_KEY = "terax:updater:last-check";
const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const GITHUB_LATEST_RELEASE =
  "https://api.github.com/repos/kevsmir02/terax-ai/releases/latest";

export interface ManualUpdateInfo {
  version: string;
  currentVersion: string;
  body: string;
  releaseUrl: string;
}

export interface PkgUpdateInfo {
  version: string;
  currentVersion: string;
  body: string;
  artifactUrl: string;
  packageManager: PackageManager;
  releaseUrl: string;
}

export type UpdaterStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "uptodate" }
  | { kind: "available"; update: Update }
  | { kind: "manual-available"; info: ManualUpdateInfo }
  | { kind: "pkg-available"; info: PkgUpdateInfo }
  | { kind: "downloading"; downloaded: number; contentLength: number | null }
  | { kind: "installing" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

function parseVersion(v: string): number[] {
  return v
    .replace(/^v/, "")
    .split("-")[0]
    .split(".")
    .map((p) => Number.parseInt(p, 10) || 0);
}

function isNewer(remote: string, current: string): boolean {
  const a = parseVersion(remote);
  const b = parseVersion(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

async function fetchPkgInfo(
  pm: PackageManager,
  current: string,
): Promise<PkgUpdateInfo | null> {
  const res = await fetch(GITHUB_LATEST_RELEASE, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const data = (await res.json()) as {
    tag_name: string;
    body?: string;
    html_url: string;
    assets: GhAsset[];
  };
  const version = data.tag_name.replace(/^v/, "");
  if (!isNewer(version, current)) return null;
  const artifactUrl = pickArtifactUrl(data.assets, pm, arch());
  if (!artifactUrl) return null;
  return {
    version,
    currentVersion: current,
    body: data.body ?? "",
    artifactUrl,
    packageManager: pm,
    releaseUrl: data.html_url,
  };
}

interface Options {
  manual?: boolean;
}

interface HookOptions {
  autoCheck?: boolean;
}

export function useUpdater({ autoCheck = true }: HookOptions = {}) {
  const [status, setStatus] = useState<UpdaterStatus>({
    kind: "idle",
  });

  const runCheck = useCallback(async ({ manual }: Options = {}) => {
    if (!manual) {
      const last = Number(localStorage.getItem(LAST_CHECK_KEY) ?? 0);
      if (Date.now() - last < CHECK_INTERVAL_MS) return;
    }
    setStatus({ kind: "checking" });
    try {
      const detect: DetectResult = await updaterDetect();
      if (detect.isAppimage) {
        const update = await check();
        setStatus(
          update
            ? { kind: "available", update }
            : { kind: "uptodate" },
        );
        if (!update)
          localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
        return;
      }
      const pm = detect.packageManager;
      if (pm) {
        const info = await fetchPkgInfo(pm, await getVersion());
        setStatus(
          info
            ? { kind: "pkg-available", info }
            : { kind: "uptodate" },
        );
        if (!info)
          localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
        return;
      }
      setStatus({
        kind: "manual-available",
        info: await fallbackInfo(),
      });
    } catch (err) {
      setStatus({ kind: "error", message: String(err) });
    }
  }, []);

  const install = useCallback(async () => {
    if (status.kind === "available") {
      const { update } = status;
      let total: number | null = null;
      let downloaded = 0;
      setStatus({
        kind: "downloading",
        downloaded: 0,
        contentLength: null,
      });
      try {
        await update.downloadAndInstall((event) => {
          if (event.event === "Started") {
            total = event.data.contentLength ?? null;
            setStatus({
              kind: "downloading",
              downloaded: 0,
              contentLength: total,
            });
          } else if (event.event === "Progress") {
            downloaded += event.data.chunkLength;
            setStatus({
              kind: "downloading",
              downloaded,
              contentLength: total,
            });
          } else if (event.event === "Finished") {
            setStatus({ kind: "ready" });
          }
        });
        await relaunch();
      } catch (err) {
        setStatus({ kind: "error", message: String(err) });
      }
      return;
    }
    if (status.kind !== "pkg-available") return;
    const { artifactUrl, packageManager, releaseUrl } = status.info;
    setStatus({
      kind: "downloading",
      downloaded: 0,
      contentLength: null,
    });
    try {
      const path = await updaterDownload(artifactUrl, (e: DownloadEvent) => {
        if (e.event === "started")
          setStatus({
            kind: "downloading",
            downloaded: 0,
            contentLength: e.contentLength,
          });
        else if (e.event === "progress")
          setStatus({
            kind: "downloading",
            downloaded: e.downloaded,
            contentLength: e.total,
          });
      });
      setStatus({ kind: "installing" });
      await updaterInstall(path, packageManager);
      await relaunch();
    } catch (err) {
      const msg = String(err);
      if (msg.startsWith("pkexec-missing")) {
        setStatus({
          kind: "manual-available",
          info: { ...status.info, releaseUrl },
        });
      } else {
        setStatus({ kind: "error", message: msg });
      }
    }
  }, [status]);

  const dismiss = useCallback(() => setStatus({ kind: "idle" }), []);

  useEffect(() => {
    if (!autoCheck) return;
    void runCheck();
  }, [autoCheck, runCheck]);

  return { status, check: runCheck, install, dismiss };
}

async function fallbackInfo(): Promise<ManualUpdateInfo> {
  const current = await getVersion();
  const res = await fetch(GITHUB_LATEST_RELEASE, {
    headers: { Accept: "application/vnd.github+json" },
  });
  const data = (await res.json()) as {
    tag_name: string;
    body?: string;
    html_url: string;
  };
  return {
    version: data.tag_name.replace(/^v/, ""),
    currentVersion: current,
    body: data.body ?? "",
    releaseUrl: data.html_url,
  };
}
