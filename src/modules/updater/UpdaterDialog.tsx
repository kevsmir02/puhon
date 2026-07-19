import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import { useUpdater } from "./useUpdater";

const RELEASE_DOWNLOAD_URL =
  "https://github.com/kevsmir02/puhon/releases/latest";

export function UpdaterDialog() {
  const { status, install, dismiss } = useUpdater();
  const [copied, setCopied] = useState(false);
  const manualVersion =
    status.kind === "manual-available" ? status.info.version : "";
  const rpmCommand = `sudo dnf install ./puhon-${manualVersion}-1.x86_64.rpm`;

  const open =
    status.kind === "available" ||
    status.kind === "pkg-available" ||
    status.kind === "manual-available" ||
    status.kind === "downloading" ||
    status.kind === "installing" ||
    status.kind === "ready";

  if (!open) return null;

  const update = status.kind === "available" ? status.update : null;
  const pkg = status.kind === "pkg-available" ? status.info : null;
  const manual = status.kind === "manual-available" ? status.info : null;
  const downloading = status.kind === "downloading";
  const ready = status.kind === "ready";
  const installing = status.kind === "installing";

  const copyCommand = async () => {
    if (!navigator?.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(rpmCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };
  const progress =
    downloading && status.contentLength
      ? Math.min(100, (status.downloaded / status.contentLength) * 100)
      : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (
          !o &&
          (status.kind === "available" ||
            status.kind === "pkg-available" ||
            status.kind === "manual-available")
        )
          dismiss();
      }}
    >
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>
            {ready
              ? "Update ready"
              : downloading
                ? "Downloading update…"
                : installing
                  ? "Installing…"
                  : pkg
                    ? `Puhon v${pkg.version} is available`
                    : manual
                      ? `Puhon v${manual.version} is available`
                      : `Puhon v${update?.version} is available`}
          </DialogTitle>
          <DialogDescription>
            {ready
              ? "Restart Puhon to finish installing."
              : downloading
                ? progress !== null
                  ? `${progress.toFixed(0)}%`
                  : "Downloading…"
                : installing
                  ? "Enter your password in the system prompt."
                  : pkg
                    ? `You're on v${pkg.currentVersion}. Installing will ask for your password.`
                    : manual
                      ? `You're on v${manual.currentVersion}. Grab the RPM from the release page or run the command below.`
                      : "A new version is ready to install."}
          </DialogDescription>
        </DialogHeader>

        {downloading && progress !== null && (
          <Progress value={progress} className="mt-2" />
        )}
        {downloading && progress === null && (
          <Progress value={undefined} className="mt-2 animate-pulse" />
        )}

        {pkg && (
          <p className="mt-2 text-sm text-muted-foreground">
            Puhon v{pkg.version} is available (you are on v{pkg.currentVersion}
            ). Installing will ask for your password.
          </p>
        )}

        {installing && (
          <p className="mt-2 text-sm text-muted-foreground">
            Installing... enter your password in the system prompt.
          </p>
        )}

        {manual && (
          <div className="mt-2 flex flex-col gap-2">
            <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/40 px-3 py-2 font-mono text-[12px]">
              <span className="flex-1 select-all">$ {rpmCommand}</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px]"
                onClick={() => void copyCommand()}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
        )}

        <DialogFooter>
          {status.kind === "available" && (
            <>
              <Button variant="ghost" size="sm" onClick={dismiss}>
                Later
              </Button>
              <Button size="sm" onClick={() => void install()}>
                Install &amp; restart
              </Button>
            </>
          )}
          {status.kind === "pkg-available" && (
            <>
              <Button variant="ghost" size="sm" onClick={dismiss}>
                Later
              </Button>
              <Button size="sm" onClick={() => void install()}>
                Install update
              </Button>
            </>
          )}
          {manual && (
            <>
              <Button variant="ghost" size="sm" onClick={dismiss}>
                Later
              </Button>
              <Button
                size="sm"
                onClick={() => void openUrl(RELEASE_DOWNLOAD_URL)}
              >
                Download RPM
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
