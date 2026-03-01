import { useMemo } from "react";
import "./Markdown.css";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderTable(lines: string[]): string {
  if (lines.length < 2) return escapeHtml(lines.join("\n"));
  const parseRow = (line: string) =>
    line.split("|").map((c) => c.trim()).filter((c) => c.length > 0);
  const headers = parseRow(lines[0]!);
  const rows = lines.slice(2).map(parseRow);
  let html = '<table class="md-table"><thead><tr>';
  for (const h of headers) html += `<th>${escapeHtml(h)}</th>`;
  html += "</tr></thead><tbody>";
  for (const row of rows) {
    html += "<tr>";
    for (const cell of row) html += `<td>${escapeHtml(cell)}</td>`;
    html += "</tr>";
  }
  html += "</tbody></table>";
  return html;
}

function markdownToHtml(text: string): string {
  const lines = text.split("\n");
  const rendered: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const nextLine = lines[i + 1];
    if (
      line.includes("|") &&
      nextLine !== undefined &&
      /^\s*\|[\s:-]+\|/.test(nextLine)
    ) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i]!.includes("|")) {
        tableLines.push(lines[i]!);
        i++;
      }
      rendered.push(renderTable(tableLines));
      continue;
    }
    rendered.push(line);
    i++;
  }

  return escapeHtml(rendered.join("\n"))
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="md-code"><code>$2</code></pre>')
    .replace(/`([^`]+)`/g, '<code class="md-inline">$1</code>')
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, "<em>$1</em>")
    .replace(/^### (.+)$/gm, '<div class="md-h3">$1</div>')
    .replace(/^## (.+)$/gm, '<div class="md-h2">$1</div>')
    .replace(/^# (.+)$/gm, '<div class="md-h1">$1</div>')
    .replace(/^---+$/gm, '<hr class="md-hr">')
    .replace(/^- \[x\] (.+)$/gm, '<div class="md-li">☑ $1</div>')
    .replace(/^- \[ \] (.+)$/gm, '<div class="md-li">☐ $1</div>')
    .replace(/^- (.+)$/gm, '<div class="md-li">• $1</div>')
    .replace(/^\d+\. (.+)$/gm, '<div class="md-li">$1</div>')
    .replace(/\n/g, "<br>");
}

interface Props {
  text: string;
  className?: string;
}

export function Markdown({ text, className }: Props) {
  const html = useMemo(() => markdownToHtml(text), [text]);
  return (
    <div
      className={`markdown ${className ?? ""}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
