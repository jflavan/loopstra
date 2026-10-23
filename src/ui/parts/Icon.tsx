const PATHS: Record<string, string> = {
  logo: "M12 3a9 9 0 1 0 9 9M12 7a5 5 0 1 0 5 5",
  live: "M3 12h4l3-8 4 16 3-8h4",
  inbox: "M4 13l2-8h12l2 8M4 13v6h16v-6M4 13h5l1 2h4l1-2h5",
  changes: "M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v6h-4z",
  activity: "M5 6h14M5 12h14M5 18h9",
  agents: "M4 5h7v6H4zM13 5h7v6h-7zM4 13h7v6H4zM13 13h7v6h-7z",
  open: "M14 4h6v6M20 4l-9 9M18 14v5H5V6h5",
  spend: "M12 3v18M16.5 7.5c0-1.7-2-3-4.5-3s-4.5 1.3-4.5 3 2 2.6 4.5 3 4.5 1.3 4.5 3-2 3-4.5 3-4.5-1.3-4.5-3",
  settings: "M4 7h9M17 7h3M4 17h3M11 17h9M15 4v6M9 14v6",
  ask: "M4 5h16v11H9l-5 4z",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4",
  bell: "M6 16v-5a6 6 0 0 1 12 0v5l2 2H4zM10 20h4",
  theme: "M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9z",
  close: "M6 6l12 12M18 6L6 18",
  pause: "M9 5v14M15 5v14",
  play: "M7 5l12 7-12 7z",
};

/** A line icon in the text's colour. */
export function Icon({ name, class: cls = "icon" }: { name: string; class?: string }) {
  return (
    <svg class={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? ""} />
    </svg>
  );
}
