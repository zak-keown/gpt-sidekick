import { style } from "@vanilla-extract/css";

export const panel = style({
  boxSizing: "border-box",
  minHeight: "100vh",
  padding: 16,
  display: "flex",
  flexDirection: "column",
  gap: 14,
  fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
  color: "#202127",
  background: "#f7f7f5",
});

export const header = style({
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
});

export const eyebrow = style({
  margin: "0 0 2px",
  color: "#706b82",
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
});

export const heading = style({
  margin: 0,
  fontSize: 18,
  lineHeight: 1.2,
  fontWeight: 700,
});

export const reindex = style({
  border: "1px solid #d7d4df",
  borderRadius: 8,
  padding: "7px 10px",
  background: "#fff",
  color: "#3f3854",
  fontSize: 12,
  fontWeight: 650,
  cursor: "pointer",
  selectors: {
    "&:hover:not(:disabled)": { borderColor: "#8d7fbd", background: "#f4f0ff" },
    "&:disabled": { cursor: "default", opacity: 0.55 },
  },
});

export const state = style({
  border: "1px solid #e2dfea",
  borderRadius: 8,
  padding: "8px 10px",
  background: "#fff",
  color: "#625d70",
  fontSize: 11,
  lineHeight: 1.35,
  selectors: {
    '&[data-kind="partial"]': { borderColor: "#e8c878", background: "#fffaf0" },
    '&[data-kind="failed"]': { borderColor: "#e3a3a3", background: "#fff4f4" },
    '&[data-kind="capturing"]': { borderColor: "#a99ad2", background: "#f6f2ff" },
    '&[data-kind="indexing"]': { borderColor: "#a99ad2", background: "#f6f2ff" },
  },
});

export const status = style({
  padding: "24px 10px",
  color: "#6c6875",
  fontSize: 13,
  lineHeight: 1.5,
  textAlign: "center",
});

export const groups = style({ display: "flex", flexDirection: "column", gap: 18 });
export const group = style({ display: "flex", flexDirection: "column", gap: 7 });

export const groupHeading = style({
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  margin: 0,
  color: "#6c6676",
  fontSize: 11,
  fontWeight: 750,
  letterSpacing: "0.07em",
  textTransform: "uppercase",
});

export const list = style({
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: 7,
});

export const item = style({
  position: "relative",
  display: "flex",
  alignItems: "stretch",
  overflow: "hidden",
  border: "1px solid #e4e1e9",
  borderRadius: 10,
  background: "#fff",
  boxShadow: "0 1px 2px rgba(25, 20, 40, 0.035)",
  selectors: { "&:hover": { borderColor: "#bcb3d3" } },
});

export const itemButton = style({
  minWidth: 0,
  flex: 1,
  padding: "10px 11px",
  display: "flex",
  flexDirection: "column",
  gap: 4,
  border: 0,
  background: "transparent",
  color: "inherit",
  textAlign: "left",
  cursor: "pointer",
});

export const title = style({
  width: "100%",
  overflowWrap: "anywhere",
  fontSize: 13,
  fontWeight: 650,
  lineHeight: 1.35,
});

export const quote = style({
  width: "100%",
  overflow: "hidden",
  color: "#77727f",
  fontSize: 11,
  lineHeight: 1.4,
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});

export const copyButton = style({
  alignSelf: "stretch",
  padding: "0 9px",
  border: 0,
  borderLeft: "1px solid #ece9f0",
  background: "#faf9fc",
  color: "#706884",
  fontSize: 10,
  fontWeight: 650,
  cursor: "pointer",
  selectors: { "&:hover": { background: "#f1ecfb", color: "#493c6a" } },
});

export const jumpState = style({
  position: "sticky",
  bottom: 10,
  alignSelf: "center",
  padding: "7px 11px",
  borderRadius: 999,
  background: "#312b40",
  color: "#fff",
  fontSize: 11,
  boxShadow: "0 5px 20px rgba(22, 16, 38, 0.2)",
});
