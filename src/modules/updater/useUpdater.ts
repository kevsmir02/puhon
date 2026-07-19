import { getVersion } from "@tauri-apps/api/app";
import { arch } from "@tauri-apps/plugin-os";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState } from "react";
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

const LAST_CHECK_KEY = "puhon:updater:last-check";
const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const GITHUB_LATEST_RELEASE =
  "https://api.github.com/repos/kevsmir02/puhon/releases/latest";

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
  | { kind: "downloading"; downloaded: number; contentLength: number | null; info?: PkgUpdateInfo; update?: Update }
  | { kind: "installing" }
  | { kind: "ready"; update?: Update; info?: PkgUpdateInfo; pkgPath?: string }
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

interface Options {
  manual?: boolean;
}

interface HookOptions {
  autoCheck?: boolean;
}

export interface UpdaterContextType {
  status: UpdaterStatus;
  isManual: boolean;
  check: (options?: Options) => Promise<void>;
  install: () => Promise<void>;
  dismiss: () => void;
}

const UpdaterContext = createContext<UpdaterContextType | null>(null);

export function UpdaterProvider({
  children,
  autoCheck = true,
}: HookOptions & { children: React.ReactNode }) {
  const [status, setStatus] = useState<UpdaterStatus>({
    kind: "idle",
  });
  const [isManual, setIsManual] = useState(false);

  const runCheck = useCallback(async ({ manual }: Options = {}) => {
    setIsManual(!!manual);
    if (!manual) {
      const last = Number(localStorage.getItem(LAST_CHECK_KEY) ?? 0);
      if (Date.now() - last < CHECK_INTERVAL_MS) return;
    }
    setStatus({ kind: "checking" });
    try {
      const detect: DetectResult = await updaterDetect();
      if (detect.isAppimage) {
        const update = await check();
        if (update) {
          setStatus({
            kind: "downloading",
            downloaded: 0,
            contentLength: null,
            update,
          });
          let total: number | null = null;
          let downloaded = 0;
          try {
            await update.download((event) => {
              if (event.event === "Started") {
                total = event.data.contentLength ?? null;
                setStatus({
                  kind: "downloading",
                  downloaded: 0,
                  contentLength: total,
                  update,
                });
              } else if (event.event === "Progress") {
                downloaded += event.data.chunkLength;
                setStatus({
                  kind: "downloading",
                  downloaded,
                  contentLength: total,
                  update,
                });
              }
            });
            setStatus({ kind: "ready", update });
          } catch (err) {
            setStatus({ kind: "error", message: String(err) });
          }
        } else {
          setStatus({ kind: "uptodate" });
          if (!manual) localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
        }
        return;
      }
      const pm = detect.packageManager;
      if (pm) {
        const info = await fetchPkgInfo(pm, await getVersion());
        if (info) {
          setStatus({
            kind: "downloading",
            downloaded: 0,
            contentLength: null,
            info,
          });
          try {
            const path = await updaterDownload(info.artifactUrl, (e: DownloadEvent) => {
              if (e.event === "started")
                setStatus({
                  kind: "downloading",
                  downloaded: 0,
                  contentLength: e.contentLength,
                  info,
                });
              else if (e.event === "progress")
                setStatus({
                  kind: "downloading",
                  downloaded: e.downloaded,
                  contentLength: e.total,
                  info,
                });
            });
            setStatus({ kind: "ready", info, pkgPath: path });
          } catch (err) {
            setStatus({ kind: "error", message: String(err) });
          }
        } else {
          setStatus({ kind: "uptodate" });
          if (!manual) localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
        }
        return;
      }
      const info = await fallbackInfo();
      if (isNewer(info.version, info.currentVersion)) {
        setStatus({
          kind: "manual-available",
          info,
        });
      } else {
        setStatus({ kind: "uptodate" });
      }
    } catch (err) {
      setStatus({ kind: "error", message: String(err) });
    }
  }, []);

  const install = useCallback(async () => {
    if (status.kind !== "ready") return;

    if (status.update) {
      try {
        setStatus({ kind: "installing" });
        await status.update.install();
        await relaunch();
      } catch (err) {
        setStatus({ kind: "error", message: String(err) });
      }
    } else if (status.info && status.pkgPath) {
      try {
        setStatus({ kind: "installing" });
        await updaterInstall(status.pkgPath, status.info.packageManager);
        await relaunch();
      } catch (err) {
        const msg = String(err);
        if (msg.startsWith("pkexec-missing")) {
          setStatus({
            kind: "manual-available",
            info: { ...status.info, releaseUrl: status.info.releaseUrl },
          });
        } else {
          setStatus({ kind: "error", message: msg });
        }
      }
    }
  }, [status]);

  const dismiss = useCallback(() => setStatus({ kind: "idle" }), []);

  useEffect(() => {
    if (!autoCheck) return;
    void runCheck();
  }, [autoCheck, runCheck]);

  const value = useMemo(
    () => ({ status, isManual, check: runCheck, install, dismiss }),
    [status, isManual, runCheck, install, dismiss]
  );

  return createElement(UpdaterContext.Provider, { value }, children);
}

export function useUpdater() {
  const context = useContext(UpdaterContext);
  if (!context) {
    throw new Error("useUpdater must be used within an UpdaterProvider");
  }
  return context;
}

