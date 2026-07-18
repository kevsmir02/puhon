import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Cancel01Icon,
  Maximize01Icon,
  ZoomIn,
  ZoomOut,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 10;
const ZOOM_STEP = 0.25;

type Props = {
  src: string;
  alt?: string;
  className?: string;
};

export function MediaLightbox({ src, alt, className }: Props) {
  const [lightbox, setLightbox] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragging = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  const reset = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  // Close on Escape
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setLightbox(false);
        reset();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [lightbox, reset]);

  const onWheel = useCallback((e: ReactWheelEvent) => {
    e.preventDefault();
    setZoom((z) =>
      Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP))),
    );
  }, []);

  const onMouseDown = useCallback(
    (e: ReactMouseEvent) => {
      if (zoom <= 1) return;
      dragging.current = true;
      lastMouse.current = { x: e.clientX, y: e.clientY };
    },
    [zoom],
  );

  const onMouseMove = useCallback((e: ReactMouseEvent) => {
    if (!dragging.current) return;
    const dx = e.clientX - lastMouse.current.x;
    const dy = e.clientY - lastMouse.current.y;
    lastMouse.current = { x: e.clientX, y: e.clientY };
    setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
  }, []);

  const onMouseUp = useCallback(() => {
    dragging.current = false;
  }, []);

  return (
    <>
      {/* Thumbnail view */}
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        onClick={() => setLightbox(true)}
        className={cn(
          "cursor-zoom-in transition-opacity hover:opacity-90",
          className,
        )}
        style={{
          backgroundImage:
            "conic-gradient(var(--muted) 0.25turn, transparent 0.25turn 0.5turn, var(--muted) 0.5turn 0.75turn, transparent 0.75turn)",
          backgroundSize: "20px 20px",
        }}
      />

      {/* Lightbox overlay */}
      {lightbox && (
        <div
          role="dialog"
          aria-label={alt ?? "Image preview"}
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setLightbox(false);
              reset();
            }
          }}
        >
          {/* Toolbar */}
          <div className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-md border border-border/60 bg-card/85 p-1 shadow-sm backdrop-blur">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() =>
                setZoom((z) => Math.min(MAX_ZOOM, z + ZOOM_STEP))
              }
              title="Zoom in"
              className="size-7 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <HugeiconsIcon
                icon={ZoomIn}
                size={14}
                strokeWidth={1.75}
              />
            </Button>
            <span className="min-w-[3.5em] text-center text-[11px] tabular-nums text-muted-foreground">
              {Math.round(zoom * 100)}%
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() =>
                setZoom((z) => Math.max(MIN_ZOOM, z - ZOOM_STEP))
              }
              title="Zoom out"
              className="size-7 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <HugeiconsIcon
                icon={ZoomOut}
                size={14}
                strokeWidth={1.75}
              />
            </Button>
            <div className="mx-0.5 h-4 w-px bg-border/60" />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() =>
                containerRef.current
                  ?.requestFullscreen?.()
                  .catch(() => {})
              }
              title="Fullscreen"
              className="size-7 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <HugeiconsIcon
                icon={Maximize01Icon}
                size={14}
                strokeWidth={1.75}
              />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => {
                setLightbox(false);
                reset();
              }}
              title="Close"
              className="size-7 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <HugeiconsIcon
                icon={Cancel01Icon}
                size={14}
                strokeWidth={1.75}
              />
            </Button>
          </div>

          {/* Zoomable image */}
          <div
            ref={containerRef}
            className="flex h-full w-full items-center justify-center overflow-hidden"
            onWheel={onWheel}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseUp}
            onDoubleClick={reset}
            style={{ cursor: zoom > 1 ? "grab" : "default" }}
          >
            <img
              src={src}
              alt={alt ?? ""}
              className="max-w-full max-h-full select-none"
              draggable={false}
              style={{
                transform: `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px)`,
                transformOrigin: "center center",
                transition: "transform 0.1s ease-out",
              }}
            />
          </div>
        </div>
      )}
    </>
  );
}
