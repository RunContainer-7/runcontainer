import React, { useMemo, useState } from "react";
import { EXE_STORE, isDirectInstall, storeCategories } from "../data/exeStore";

// The EXE Store.
//
// It answers one question — "what could I add?" — without sending anyone to a website to
// find out. Every entry installs into RunContainer, never into Windows: the same download
// and validation path the Sources tab uses, so the app appears under My Apps in its own
// folder.
//
// Entries without a verified direct link say "Get installer" and open the publisher's
// page. That is deliberate: a store button that 404s is worse than an honest trip to the
// vendor, and RunContainer does not host or mirror other people's installers.
export default function ExeStore({ onClose, onInstall, onOpenPage, busyId, message, installedNames = [] }) {
  const [category, setCategory] = useState("All");
  const categories = useMemo(() => storeCategories(), []);
  const visible = useMemo(
    () => (category === "All" ? EXE_STORE : EXE_STORE.filter((entry) => entry.category === category)),
    [category],
  );
  const installed = useMemo(() => new Set(installedNames), [installedNames]);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="EXE Store">
      <div className="detail-panel store-panel">
        <div className="beginner-header">
          <div>
            <span className="beginner-kicker">EXE Store</span>
            <h3>Apps you can add in one press</h3>
          </div>
          <span className="beginner-count">{EXE_STORE.length} apps</span>
        </div>

        <p className="beginner-lead">
          Everything here is installed into RunContainer, not into Windows: it gets its own
          folder, its own data and its own limits, and it appears under My Apps.
        </p>

        <div className="store-filters" role="group" aria-label="Filter by category">
          {categories.map((name) => (
            <button
              key={name}
              className={`store-filter${category === name ? " active" : ""}`}
              onClick={() => setCategory(name)}
              aria-pressed={category === name}
            >
              {name}
            </button>
          ))}
        </div>

        <div className="store-grid">
          {visible.map((entry) => {
            const direct = isDirectInstall(entry);
            const already = installed.has(entry.name);
            return (
              <article className="store-card" key={entry.id}>
                <div className="store-card-top">
                  <span className="store-glyph" aria-hidden="true">{entry.glyph}</span>
                  <div className="store-title">
                    <strong>{entry.name}</strong>
                    <span className="muted">{entry.publisher}</span>
                  </div>
                </div>
                <p className="store-summary">{entry.summary}</p>
                <div className="store-meta">
                  <span>{entry.category}</span>
                  <span>~{entry.approxSizeMb} MB</span>
                  <span>{entry.license}</span>
                </div>
                <p className="store-note muted">{entry.installNote}</p>
                <div className="detail-actions store-actions">
                  {direct ? (
                    <button
                      className="settings-button"
                      onClick={() => onInstall(entry)}
                      disabled={busyId === entry.id}
                    >
                      {busyId === entry.id ? "Installing…" : already ? "Install again" : "Install"}
                    </button>
                  ) : (
                    <button className="settings-button" onClick={() => onOpenPage(entry)}>
                      Get installer
                    </button>
                  )}
                  {!direct && (
                    <button className="settings-button ghost" onClick={() => onOpenPage(entry)}>
                      Download page
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>

        {message && <p className="store-message" role="status">{message}</p>}

        <div className="beginner-footer">
          <p className="beginner-foot-note muted">
            Links go to the publisher, not to a RunContainer mirror. Nothing is installed
            into the rest of Windows.
          </p>
          <div className="detail-actions">
            <button className="settings-button ghost" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </div>
  );
}
