import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useUpdater } from "@/modules/updater";
import { GithubIcon, Globe02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { getName, getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { arch, platform } from "@tauri-apps/plugin-os";
import { useEffect, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";

const REPO_URL = "https://github.com/kevsmir02/puhon";
const WEBSITE = "https://github.com/kevsmir02/puhon";

const PLATFORM_LABEL: Record<string, string> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
  ios: "iOS",
  android: "Android",
  freebsd: "FreeBSD",
};

export function AboutSection() {
  const [version, setVersion] = useState("");
  const [name, setName] = useState("Puhon");
  const [build, setBuild] = useState("");
  const [copied, setCopied] = useState(false);
  const { status, check, install } = useUpdater();

  const checking = status.kind === "checking";
  const downloading = status.kind === "downloading";
  const installing = status.kind === "installing";
  const ready = status.kind === "ready";
  const manualAvailable = status.kind === "manual-available";
  const error = status.kind === "error";

  const activePkg = ready ? status.info : downloading ? status.info : null;
  const activeUpdate = ready
    ? status.update
    : downloading
      ? status.update
      : null;
  const manual = manualAvailable ? status.info : null;

  const manualVersion = manual ? manual.version : "";
  const rpmCommand = `sudo dnf install ./puhon-${manualVersion}-1.x86_64.rpm`;

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
      ? Math.min(
          100,
          Math.round((status.downloaded / status.contentLength) * 100),
        )
      : null;

  const checkLabel =
    status.kind === "uptodate"
      ? "You're up to date"
      : error
        ? "Check failed — retry"
        : checking
          ? "Checking…"
          : downloading
            ? "Downloading…"
            : installing
              ? "Installing…"
              : ready
                ? activeUpdate
                  ? "Restart to install update"
                  : "Install update"
                : manualAvailable
                  ? `Download v${status.info.version}`
                  : "Check for updates";

  const onUpdateClick = () => {
    if (ready) {
      void install();
    } else if (manualAvailable && manual) {
      void openUrl(manual.releaseUrl);
    } else {
      void check({ manual: true });
    }
  };

  useEffect(() => {
    void getVersion().then(setVersion);
    void getName().then(setName);
    try {
      const p = platform();
      const a = arch();
      const platformLabel = PLATFORM_LABEL[p] ?? p;
      setBuild(`${platformLabel} · ${a}`);
    } catch {
      setBuild("");
    }
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader title="About" description="" />

      <div className="flex items-center gap-4 rounded-xl border border-border/60 bg-card/60 p-5">
        <img src="/logo.png" alt="" className="size-12" draggable={false} />
        <div className="flex min-w-0 flex-col">
          <span className="text-[15px] font-semibold tracking-tight">
            {name}
          </span>
          <span className="text-[11px] text-muted-foreground">
            Open-source AI-native terminal emulator
          </span>
          <span className="mt-1 font-mono text-[11px] text-muted-foreground">
            v{version || "—"}
          </span>
        </div>
      </div>

      <dl className="grid grid-cols-[110px_1fr] gap-y-2.5 text-[12px]">
        <dt className="text-muted-foreground">Build</dt>
        <dd className="font-mono text-[11.5px]">
          {build ? `${build} · v${version}` : `v${version}`}
        </dd>

        <dt className="text-muted-foreground">Bundle ID</dt>
        <dd className="font-mono text-[11.5px]">app.kevsmir02.puhon</dd>

        <dt className="text-muted-foreground">License</dt>
        <dd>Apache 2.0</dd>

        <dt className="text-muted-foreground">Source code</dt>
        <dd>
          <button
            type="button"
            onClick={() => void openUrl(REPO_URL)}
            className="inline-flex items-center gap-1.5 rounded-md text-[12px] underline-offset-2 hover:text-foreground hover:underline"
          >
            <HugeiconsIcon icon={GithubIcon} size={12} strokeWidth={1.75} />
            kevsmir02/puhon
          </button>
        </dd>
        <dt className="text-muted-foreground">Website</dt>
        <dd>
          <button
            type="button"
            onClick={() => void openUrl(WEBSITE)}
            className="inline-flex items-center gap-1.5 rounded-md text-[12px] underline-offset-2 hover:text-foreground hover:underline"
          >
            <HugeiconsIcon icon={Globe02Icon} size={12} strokeWidth={1.75} />
            github.com/kevsmir02/puhon
          </button>
        </dd>
      </dl>

      <div className="flex flex-col gap-2.5">
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={onUpdateClick}
            disabled={checking || downloading || installing}
          >
            {checkLabel}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void openUrl(REPO_URL)}
            className="gap-1.5"
          >
            <HugeiconsIcon icon={GithubIcon} size={12} strokeWidth={1.75} />
            View on GitHub
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void openUrl(`${REPO_URL}/issues/new`)}
          >
            Report an issue
          </Button>
        </div>

        {downloading && (
          <div className="flex flex-col gap-1.5 max-w-sm mt-1">
            <Progress value={progress ?? undefined} className="h-1.5" />
            <p className="text-[11px] text-muted-foreground">
              {progress !== null
                ? `Downloading update… ${progress}%`
                : "Downloading update…"}
            </p>
          </div>
        )}

        {ready && (
          <p className="text-[12px] text-emerald-400">
            {activeUpdate
              ? "Update downloaded! Click above to restart Puhon and finish installing."
              : `Puhon v${activePkg?.version ?? ""} update ready. Click above to install (will ask for password if required).`}
          </p>
        )}

        {installing && (
          <p className="text-[12px] text-muted-foreground">
            Installing update… please enter your password if prompted.
          </p>
        )}

        {manual && (
          <div className="flex flex-col gap-2 mt-1">
            <p className="text-[12px] text-muted-foreground">
              Puhon v{manual.version} is available. Download the package from
              GitHub releases or run:
            </p>
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

        {error && (
          <p className="font-mono text-[10.5px] break-all text-destructive/80">
            {status.message}
          </p>
        )}
      </div>
    </div>
  );
}
