import { Fragment } from "react";

/** Renders the small subset of markdown the assistant uses: **bold**, line breaks and "- " bullets. */
export function RichText({ text }: { text: string }) {
  const lines = text.split(/\n+/).filter((l) => l.trim());
  const bullets = lines.filter((l) => /^\s*[-*•]\s+/.test(l));
  if (bullets.length >= 2 && bullets.length >= lines.length - 1) {
    const [first, ...rest] = /^\s*[-*•]\s+/.test(lines[0]) ? ["", ...lines] : lines;
    return (
      <>
        {first && <span>{inline(first)}</span>}
        <ul className="rt-list">
          {rest.map((l, i) => (
            <li key={i}>{inline(l.replace(/^\s*[-*•]\s+/, ""))}</li>
          ))}
        </ul>
      </>
    );
  }
  return (
    <>
      {lines.map((l, i) => (
        <Fragment key={i}>
          {i > 0 && <br />}
          {inline(l)}
        </Fragment>
      ))}
    </>
  );
}

function inline(s: string) {
  return s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>,
  );
}
