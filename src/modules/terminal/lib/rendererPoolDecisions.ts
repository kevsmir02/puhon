export type LeafEvictionFlags = {
  visible: boolean;
  altScreen: boolean;
  busy: boolean;
  blocks: boolean;
  focused: boolean;
  lastUsedAt: number;
};

export function leafEvictionScore(f: LeafEvictionFlags): number {
  return (
    (f.visible ? 1000 : 0) +
    (f.altScreen ? 100 : 0) +
    (f.busy ? 80 : 0) +
    (f.blocks ? 50 : 0) +
    (f.focused ? 10 : 0) +
    f.lastUsedAt / 1e12
  );
}
