"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { BellRing, Check, ChevronLeft, ChevronsUpDown, Flame, LoaderCircle, MapPinned } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";

type Market = { id: string; name: string; state: string; abbreviation: string };
const STORAGE_KEY = "fire-growth-tracker-dma";
const ALERT_STORAGE_KEY = "fire-growth-tracker-alert-preferences";
type AlertPreferences = {
  coverageNewFires: boolean;
  evacuationChanges: boolean;
  growthThresholdAcres: number;
  containmentThresholdPoints: number;
};
const DEFAULT_ALERTS: AlertPreferences = {
  coverageNewFires: true,
  evacuationChanges: true,
  growthThresholdAcres: 100,
  containmentThresholdPoints: 10,
};

export default function DmaSettings() {
  const [markets, setMarkets] = useState<Market[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [savedId, setSavedId] = useState("");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<AlertPreferences>(DEFAULT_ALERTS);
  const [alertsSaved, setAlertsSaved] = useState(false);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Market | null;
      if (saved?.id) { setSelectedId(saved.id); setSavedId(saved.id); }
    } catch { localStorage.removeItem(STORAGE_KEY); }
    try {
      const storedAlerts = JSON.parse(localStorage.getItem(ALERT_STORAGE_KEY) ?? "null") as Partial<AlertPreferences> | null;
      if (storedAlerts) setAlerts({ ...DEFAULT_ALERTS, ...storedAlerts });
    } catch { localStorage.removeItem(ALERT_STORAGE_KEY); }

    fetch("/api/dmas")
      .then(async (response) => {
        const payload = await response.json() as { markets?: Market[]; error?: string };
        if (!response.ok || payload.error) throw new Error(payload.error ?? "Unable to load TV markets");
        setMarkets(payload.markets ?? []);
      })
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : "Unable to load TV markets"))
      .finally(() => setLoading(false));
  }, []);

  const selected = useMemo(() => markets.find((market) => market.id === selectedId) ?? null, [markets, selectedId]);

  const save = () => {
    if (!selected) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(selected));
    window.location.href = "/";
  };

  const clear = () => {
    localStorage.removeItem(STORAGE_KEY);
    setSelectedId("");
    setSavedId("");
  };

  const saveAlerts = async () => {
    localStorage.setItem(ALERT_STORAGE_KEY, JSON.stringify(alerts));
    if ((alerts.coverageNewFires || alerts.evacuationChanges) && "Notification" in window && Notification.permission === "default") {
      await Notification.requestPermission();
    }
    setAlertsSaved(true);
    window.setTimeout(() => setAlertsSaved(false), 2200);
  };

  return (
    <main className="settings-shell">
      <header className="topbar settings-topbar">
        <div className="brand-mark"><Flame size={19} fill="currentColor" /></div>
        <div><h1>Fire Growth Tracker</h1><p>Coverage settings</p></div>
        <Button asChild variant="ghost" className="settings-back"><Link href="/"><ChevronLeft size={16} /> Back to tracker</Link></Button>
      </header>

      <section className="settings-card">
        <div className="settings-icon"><MapPinned size={24} /></div>
        <p className="eyebrow">TELEVISION COVERAGE</p>
        <h2>Select your DMA</h2>
        <p className="settings-intro">The tracker is California-only. Choose a California-serving television market to limit fires, perimeters and evacuation zones to that DMA, or clear the selection for a statewide view.</p>

        <label className="settings-label">Designated Market Area</label>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" role="combobox" aria-expanded={open} className="dma-picker" disabled={loading}>
              {loading ? <><LoaderCircle className="spin" size={16} /> Loading TV markets…</> : selected?.name ?? "Choose a TV market"}
              <ChevronsUpDown size={16} />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="dma-popover" align="start">
            <Command>
              <CommandInput placeholder="Search city or market…" />
              <CommandList>
                <CommandEmpty>No television market found.</CommandEmpty>
                <CommandGroup>
                  {markets.map((market) => (
                    <CommandItem
                      key={market.id}
                      value={`${market.name} ${market.state}`}
                      onSelect={() => { setSelectedId(market.id); setOpen(false); }}
                    >
                      <Check size={15} className={selectedId === market.id ? "market-check visible" : "market-check"} />
                      <span>{market.name}</span>
                      <small>DMA {market.id}</small>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>

        {selected && (
          <div className="market-summary">
            <span>SELECTED COVERAGE</span>
            <strong>{selected.name}</strong>
            <p>{selected.state} • DMA {selected.id}</p>
          </div>
        )}
        {error && <p className="settings-error">{error}</p>}

        <div className="settings-actions">
          <Button onClick={save} disabled={!selected || selectedId === savedId}>Save coverage area</Button>
          {savedId && <Button variant="ghost" onClick={clear}>Clear selection</Button>}
        </div>
        <p className="settings-source">The list includes California markets and nearby cross-border DMAs that serve California communities. Boundaries are defined by Nielsen and displayed through Esri’s public DMA boundary service.</p>
      </section>

      <section className="settings-card alert-settings-card">
        <div className="settings-icon"><BellRing size={23} /></div>
        <p className="eyebrow">ALERTS</p>
        <h2>Coverage notifications</h2>
        <p className="settings-intro">Choose what should trigger an in-app alert and, when permitted, a browser notification while the tracker is open. Individual fires can be followed from their detail panel.</p>

        <div className="alert-setting-row">
          <div><strong>New fires in my coverage area</strong><span>Notify when a newly reported start appears in the selected DMA.</span></div>
          <Switch checked={alerts.coverageNewFires} onCheckedChange={(checked) => setAlerts((current) => ({ ...current, coverageNewFires: checked }))} aria-label="New fire alerts" />
        </div>
        <div className="alert-setting-row">
          <div><strong>Evacuation changes</strong><span>Notify when active evacuation zones touching a followed fire change.</span></div>
          <Switch checked={alerts.evacuationChanges} onCheckedChange={(checked) => setAlerts((current) => ({ ...current, evacuationChanges: checked }))} aria-label="Evacuation change alerts" />
        </div>

        <div className="threshold-grid">
          <label>
            <span>Growth alert threshold</span>
            <div><input type="number" min="1" max="100000" step="50" value={alerts.growthThresholdAcres} onChange={(event) => setAlerts((current) => ({ ...current, growthThresholdAcres: Math.max(1, Number(event.target.value) || 1) }))} /><b>acres</b></div>
          </label>
          <label>
            <span>Containment-change threshold</span>
            <div><input type="number" min="1" max="100" step="1" value={alerts.containmentThresholdPoints} onChange={(event) => setAlerts((current) => ({ ...current, containmentThresholdPoints: Math.max(1, Number(event.target.value) || 1) }))} /><b>points</b></div>
          </label>
        </div>

        <div className="settings-actions">
          <Button onClick={() => void saveAlerts()}>{alertsSaved ? <><Check size={15} /> Saved</> : "Save alert settings"}</Button>
        </div>
        <p className="settings-source">Browser notifications require permission and are evaluated whenever the tracker is running and receives a fresh data update.</p>
      </section>
    </main>
  );
}
