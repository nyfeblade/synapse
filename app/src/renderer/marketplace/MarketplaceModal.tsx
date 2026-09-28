import { useLayoutEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { STR, STR5, type CatalogEntry } from "@synapse/shared";
import { Dialog } from "../components/Dialog";
import { BackIcon, CloseIcon, SearchIcon } from "../components/Icons";
import { EmptyView } from "../components/EmptyView";
import { useTemplates } from "../templates/store";
import { LogoTile } from "./LogoTile";
import { useGoogle } from "../google/store";
import { hasTemplateAdder, useMarketplace } from "./store";

/** Local label: shared/src/strings-phase5.ts belongs to another track this cycle. */
const LISTING_UNAVAILABLE = "This listing isn't available yet.";

/** A connector's state, as a quiet word beside its one verb — not a disabled button pretending to be one. */
function Status({ text, title }: { text: string; title?: string }) {
  return <span className="mkt-status" title={title}>{text}</span>;
}

/**
 * UI polish pass: ONE verb per row — Add, Authorize or Manage — with the state (Connected, Added,
 * Not available) as a quiet accessory. "Connect" and "Add" were two words for the same first step.
 */
function Pill({ e }: { e: CatalogEntry }) {
  const { add, reopen, waiting } = useMarketplace();
  const manage = () => useMarketplace.setState({ page: "manage" });
  // ORIG-GOOGLE: Gmail, Calendar and Drive are the built-in connector; every state opens the Connect Google sheet.
  if (e.source === "google") {
    const openSheet = () => useGoogle.getState().openSheet();
    if (e.state === "connected") return <span className="mkt-action"><Status text={STR5.statusConnected} /><button type="button" className="pill" aria-label={STR5.manageAria(e.name)} onClick={openSheet}>{STR5.manage}</button></span>;
    const label = e.state === "needs-auth" ? STR5.authorize : STR5.add;
    return <button type="button" className="pill" aria-label={`${label} ${e.name}`} onClick={openSheet}>{label}</button>;
  }
  const isWaiting = e.state === "waiting-auth" || !!waiting[e.id] && e.state !== "installed" && e.state !== "connected";
  if (isWaiting) return (
    <span className="pill-wait"><span className="muted">{STR5.waitingForAuthorization}</span>
      <button type="button" className="link-btn" onClick={() => void reopen(e)}>{STR5.reopen}</button></span>
  );
  // An entry that can't be added here is never presented as installable.
  if (e.state === "unavailable") return <span role="img" aria-label={`${e.name}: ${STR5.notAvailable}`}><Status text={STR5.notAvailable} /></span>;
  if (e.state === "needs-auth") return <button type="button" className="pill" aria-label={`${STR5.authorize} ${e.name}`} onClick={() => void add(e)}>{STR5.authorize}</button>;
  if (e.state !== "available") {
    const status = e.action === "connect" || e.state === "connected" ? STR5.statusConnected : STR5.statusAdded;
    return <span className="mkt-action"><Status text={status} /><button type="button" className="pill" aria-label={STR5.manageAria(e.name)} onClick={manage}>{STR5.manage}</button></span>;
  }
  const disabled = e.kind === "bot-template" && !hasTemplateAdder();
  return <button type="button" className="pill" aria-label={STR5.addAria(e.name)} disabled={disabled} onClick={() => void add(e)}>{STR5.add}</button>;
}

function Row({ e, sub }: { e: CatalogEntry; sub?: string }) {
  const { openDetail } = useMarketplace();
  return (
    <div className="mkt-row">
      <a href="#" aria-label={STR5.openAria(e.name)} className="mkt-row-main" onClick={(ev) => { ev.preventDefault(); openDetail(e.id); }}>
        <LogoTile name={e.name} logo={e.logo} />
        <span className="mkt-row-text"><span>{e.name}{e.kind === "bot-template" && e.source === "starter" && <span className="muted"> {STR5.byTeam}</span>}</span><span className="muted ellipsis">{sub ?? e.description}</span></span>
      </a>
      <Pill e={e} />
    </div>
  );
}

/** UI polish pass: one column of rows, at most five before "Show N more", so a section is a list you
 *  can scan rather than a wall of buttons. (`grid` is kept on the call sites' signature and ignored.) */
const SECTION_ROWS = 5;
function Section({ title, entries, sub }: { title: string; entries: CatalogEntry[]; sub?: string; grid?: boolean }) {
  const [all, setAll] = useState(false);
  if (!entries.length) return null;
  const shown = all ? entries : entries.slice(0, SECTION_ROWS);
  const more = entries.length - shown.length;
  return (
    <section aria-label={title} className="mkt-section">
      <div className="mkt-section-head"><h3>{title}</h3></div>
      {sub && <span className="muted mkt-sub">{sub}</span>}
      <div className="mkt-list">{shown.map((e) => <Row key={e.id} e={e} />)}</div>
      {more > 0 && <button type="button" className="link-btn mkt-more" onClick={() => setAll(true)}>{STR5.showMore(more)}</button>}
    </section>
  );
}

export function MarketplaceModal() {
  const s = useMarketplace();
  const [sel, setSel] = useState(-1);
  const flat = useMemo(() => [...(s.results?.plugins ?? []), ...(s.results?.bots ?? [])], [s.results]);
  // A page change inside this one dialog — home → detail → back — is a new view, but not a new
  // layer, so the Dialog primitive never sees it and focus was simply dropped on <body>. The surface
  // moves it to the top of whatever it just navigated to.
  const body = useRef<HTMLDivElement>(null);
  const page = s.open ? s.page : null;
  useLayoutEffect(() => {
    if (!page || page === "home") return;
    const first = body.current?.querySelector<HTMLElement>("button:not([disabled]), [href], input, select, textarea");
    first?.focus();
  }, [page, s.detailId]);
  // The `!sheetAbove` predicate is gone. It knew about the template sheets, because those existed
  // when it was written — and not about the Connect Google sheet, which opens from this modal's own
  // Gmail row and was closed along with the Marketplace by a single Escape. The overlay stack knows
  // about every layer, including the ones added after this file was last touched.
  if (!s.open) return null;
  const v = s.view;
  const detail = s.page === "detail" ? [...flat, ...(v ? [...v.featuredBots, ...v.fromTeam, ...v.featuredPlugins, ...(v.forYou?.entries ?? []), ...v.categories.flatMap((c) => c.entries)] : [])].find((e) => e.id === s.detailId) : undefined;
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((i) => Math.min(flat.length - 1, i + 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setSel((i) => Math.max(-1, i - 1)); }
    if (e.key === "Enter") { e.preventDefault(); if (sel >= 0 && flat[sel]) s.openDetail(flat[sel]!.id); else s.showAll(); }
  };
  return (
    <Dialog label={STR5.marketplace} onClose={s.close} className="mkt-dialog">
      <>
        <div className="mkt-head">
          <h2>{STR5.marketplace}</h2>
          {v && (
            <a href="#" className="mkt-installed" aria-label={STR5.yourPluginsAria(v.installed.count)} onClick={(e) => { e.preventDefault(); useMarketplace.setState({ page: "manage" }); }}>
              <span className="logo-stack">{v.installed.logos.map((l) => <LogoTile key={l.name} name={l.name} logo={l.logo} size={22} />)}</span>
              <span>{STR5.yourPlugins(v.installed.count)}</span>
            </a>
          )}
          <button type="button" className="icon-btn" aria-label={STR5.closeMarketplace} onClick={s.close}><CloseIcon /></button>
        </div>
        {s.error && <span className="error" role="alert">{s.error}</span>}
        <div className="mkt-search">
          <SearchIcon />
          <input role="combobox" aria-expanded={!!s.results && s.page !== "results"} aria-controls="mkt-typeahead" aria-label={STR5.searchPlaceholder} placeholder={STR5.searchPlaceholder}
            value={s.query} onChange={(e) => { setSel(-1); void s.setQuery(e.target.value); }} onKeyDown={onKeyDown} />
          {s.query && <button type="button" className="link-btn" onClick={() => void s.setQuery("")}>{STR5.clear}</button>}
          {s.results && s.page === "home" && (
            <ul id="mkt-typeahead" role="listbox" className="picker mkt-typeahead">
              {s.results.plugins.length > 0 && <li role="presentation" className="pick-group">Plugins ›</li>}
              {s.results.plugins.map((e, i) => <li key={e.id} role="option" aria-selected={sel === i} className={sel === i ? "pick selected" : "pick"} onMouseDown={() => s.openDetail(e.id)}><LogoTile name={e.name} logo={e.logo} size={20} /><span className="pick-label">{e.name}</span></li>)}
              {s.results.bots.length > 0 && <li role="presentation" className="pick-group">{STR5.bots}</li>}
              {s.results.bots.map((e, j) => { const i = s.results!.plugins.length + j; return <li key={e.id} role="option" aria-selected={sel === i} className={sel === i ? "pick selected" : "pick"} onMouseDown={() => s.openDetail(e.id)}><LogoTile name={e.name} logo={e.logo} size={20} /><span className="pick-label">{e.name}</span><span className="muted">{e.source === "starter" ? STR5.byTeam : e.author?.name}</span></li>; })}
              {!flat.length && <li role="presentation" className="pick muted">{STR5.noResults}</li>}
            </ul>
          )}
        </div>
        <div ref={body} className="mkt-body">
          {s.page === "detail" && (
            <section aria-label={detail?.name ?? STR5.marketplace} className="mkt-detail">
              <button type="button" className="icon-btn" aria-label={STR5.back} onClick={s.closeDetail}><BackIcon /></button>
              {detail ? (
                <>
                  <LogoTile name={detail.name} logo={detail.logo} size={56} />
                  <h3>{detail.name}</h3>
                  <p className="muted">{detail.description}</p>
                  <Pill e={detail} />
                </>
              ) : (
                <p role="status" className="muted">{LISTING_UNAVAILABLE}</p>
              )}
            </section>
          )}
          {s.page === "results" && s.results && (
            flat.length ? (
              <>
                <Section title={STR5.plugins} entries={s.results.plugins} />
                <Section title={STR5.bots} entries={s.results.bots} />
              </>
            ) : <EmptyView icon={<SearchIcon size={18} />} title={STR5.noResults} size="inline" action={{ label: STR5.clear, onClick: () => void s.setQuery("") }} />
          )}
          {/* The loading branch was simply missing: between opening the Marketplace and the catalog
              arriving — and forever, if it never arrived and `error` was not set — the body was an
              empty rectangle under the search box. */}
          {s.page === "home" && !v && !s.error && <p role="status" className="muted mkt-loading">{STR.loading}</p>}
          {s.page === "home" && v && (
            <>
              {v.featuredBots.length > 0 && (
                <section aria-label={STR5.featuredBots} className="mkt-section">
                  <h3>{STR5.featuredBots}</h3>
                  <div className="mkt-cards">
                    {v.featuredBots.map((e) => (
                      <a key={e.id} href="#" aria-label={STR5.openAria(e.name)} className="mkt-card" onClick={(ev) => { ev.preventDefault(); s.openDetail(e.id); }}>
                        <span className="author">{e.author?.avatarUrl ? <img src={e.author.avatarUrl} alt="" /> : <span className="author-initial">{e.author?.name.charAt(0)}</span>}</span>
                        <span className="muted">{STR5.authorsBot(e.author?.name ?? "")}</span>
                        <span>{e.name}</span>
                      </a>
                    ))}
                  </div>
                </section>
              )}
              {v.forYou && <Section title={STR5.forYou} sub={STR5.becauseYouUse(v.forYou.because)} entries={v.forYou.entries} grid />}
              <Section title={STR5.fromTeam} entries={v.fromTeam} />
              <Section title={STR5.featuredPlugins} entries={v.featuredPlugins} grid />
              {v.categories.map((c) => <Section key={c.name} title={c.name} entries={c.entries} grid />)}
            </>
          )}
          {s.page === "manage" && <ManageSlot />}
        </div>
      </>
    </Dialog>
  );
}

let ManageComponent: ComponentType | null = null;
export function registerManagePage(C: ComponentType): void { ManageComponent = C; }
function ManageSlot() { return ManageComponent ? <ManageComponent /> : null; }
