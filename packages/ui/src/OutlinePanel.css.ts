import { style } from "@vanilla-extract/css";

export const panel = style({
  fontFamily: "system-ui, sans-serif",
  padding: 16,
  display: "flex",
  flexDirection: "column",
  gap: 8,
});

export const heading = style({
  fontSize: 14,
  fontWeight: 600,
  margin: 0,
  opacity: 0.6,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
});

export const status = style({
  fontFamily: "system-ui, sans-serif",
  padding: 16,
  opacity: 0.7,
  fontSize: 14,
});

export const list = style({
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: 6,
});

export const item = style({
  display: "flex",
  gap: 8,
  alignItems: "baseline",
  padding: "6px 8px",
  borderRadius: 6,
  fontSize: 14,
  lineHeight: 1.4,
  ":hover": { background: "rgba(127,127,127,0.12)" },
});

export const type = style({
  flexShrink: 0,
  fontSize: 10,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  opacity: 0.55,
  minWidth: 62,
});

export const title = style({
  minWidth: 0,
  overflowWrap: "anywhere",
});
