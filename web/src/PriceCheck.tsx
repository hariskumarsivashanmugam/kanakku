import { useEffect, useState } from "react";
import { api, type PriceCheck as PC } from "./api";
import { money } from "./state";
import { Loading, Modal, Notice } from "./components";

/** Channel3 price check for one product, shown in a dialog. */
export function PriceCheckDialog({ product, onClose }: { product: string | null; onClose: () => void }) {
  const [data, setData] = useState<PC | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!product) return;
    setData(null);
    setError("");
    api.priceCheck(product).then(setData, (e: Error) => setError(e.message));
  }, [product]);

  return (
    <Modal open={Boolean(product)} onClose={onClose} title={product ? `Price check: ${product}` : "Price check"} wide>
      {error && <Notice>{error}</Notice>}
      {!data && !error && <Loading label="Searching other retailers…" />}
      {data && (
        <div className="pc">
          <p className={`pc-verdict pc-${data.verdict}`}>{data.summary}</p>
          {data.median !== null && data.low !== null && data.high !== null && <PriceRange d={data} />}
          <h3 className="pc-sub">Similar products from other retailers</h3>
          {data.comparables.length === 0 ? (
            <p className="muted">No similar products with a price in {data.currency} were found.</p>
          ) : (
            <ul className="pc-list">
              {data.comparables.map((c, i) => (
                <li key={i}>
                  {c.image ? <img src={c.image} alt="" loading="lazy" /> : <span className="pc-noimg" aria-hidden />}
                  <span className="pc-title">
                    {c.url ? (
                      <a href={c.url} target="_blank" rel="noopener noreferrer">
                        {c.title}
                      </a>
                    ) : (
                      c.title
                    )}
                    <span className="muted">{c.merchant}</span>
                  </span>
                  <strong>{money(c.price, c.currency)}</strong>
                </li>
              ))}
            </ul>
          )}
          <p className="pc-credit muted">Product data from Channel3, searched {new Date(data.checkedAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}.</p>
        </div>
      )}
    </Modal>
  );
}

function PriceRange({ d }: { d: PC }) {
  const lo = Math.min(d.low!, d.yourPrice) * 0.9;
  const hi = Math.max(d.high!, d.yourPrice) * 1.1;
  const pos = (v: number) => `${((v - lo) / (hi - lo)) * 100}%`;
  return (
    <div className="pc-range" role="img" aria-label={`Similar items cost ${money(d.low!, d.currency)} to ${money(d.high!, d.currency)}, typically ${money(d.median!, d.currency)}. You charge ${money(d.yourPrice, d.currency)}.`}>
      <div className="pc-track">
        <span className="pc-band" style={{ left: pos(d.low!), width: `calc(${pos(d.high!)} - ${pos(d.low!)})` }} />
        <span className="pc-median" style={{ left: pos(d.median!) }} />
        <span className="pc-you" style={{ left: pos(d.yourPrice) }} />
      </div>
      <div className="pc-labels">
        <span style={{ left: pos(d.low!) }}>{money(d.low!, d.currency, 0)}</span>
        <span style={{ left: pos(d.median!) }} className="pc-label-median">
          typical {money(d.median!, d.currency, 0)}
        </span>
        <span style={{ left: pos(d.high!) }}>{money(d.high!, d.currency, 0)}</span>
      </div>
      <div className="pc-you-label" style={{ left: pos(d.yourPrice) }}>
        You: {money(d.yourPrice, d.currency)}
      </div>
    </div>
  );
}
