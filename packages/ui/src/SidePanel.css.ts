import { style } from "@vanilla-extract/css";

export const panel = style({
  fontFamily: "system-ui, sans-serif",
  padding: 16,
  display: "flex",
  flexDirection: "column",
  gap: 8,
});

export const reply = style({
  padding: 8,
  borderRadius: 4,
  background: "#f0f0f0",
  minHeight: "1.5em",
});
