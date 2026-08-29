"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Archive, BellRing, Check, ChevronLeft, ChevronsUpDown, Download, Flame, Gauge, LoaderCircle, MapPinned } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";

type Market = { id: string; name: string; state: string; abbreviation: string };
const STORAGE_KEY = "fire-growth-tracker-dma";
const ALERT_STORAGE_KEY = "fire-growth-tracker-alert-preferences";
const METRICS_STORAGE_KEY = "fire-growth-tracker-metrics";
type MetricId = "tracked" | "new" | "perimeters" | "evacuations" | "hotspots" | "following" | "acres" | "updated";
const DEFAULT_METRICS: MetricId[] = ["tracked", "new", "perimeters", "evacuations", "hotspots"];
const METRIC_OPTIONS: Array<{ id: MetricId; label: string; description: string }> = [
  { id: "tracked", label: "Tracked fires", description: "All active fire records in the selected coverage area." },
  { id: "new", label: "New in 24 hours", description: "Recently reported starts from California Wildfire Intel." },
  { id: "perimeters", label: "Live perimeters", description: "Active published fire perimeter shapes." },
  { id: "evacuations", label: "Evacuation orders / warnings", description: "Current CAL OES order and warning counts." },
  { id: "hotspots", label: "VIIRS hotspots", description: "Thermal detections reported in the last 24 hours." },
  { id: "following", label: "Followed fires", description: "Active incidents you are following." },
  { id: "acres", label: "Active reported acres", description: "Combined reported acreage for tracked fires." },
  { id: "updated", label: "Perimeters updated in 24 hours", description: "Shapes with a publication time in the last day." },
];
type ArchiveDay = { date: string; perimeterCount: number; capturedAt: number };
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
  const [metrics, setMetrics] = useState<MetricId[]>(DEFAULT_METRICS);
  const [metricsSaved, setMetricsSaved] = useState(false);
  const [archiveDays, setArchiveDays] = useState<ArchiveDay[]>([]);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Market | null;
      if (saved?.id) { setSelectedId(saved.id); setSavedId(saved.id); }
    } catch { localStorage.removeItem(STORAGE_KEY); }
    try {
      const storedAlerts = JSON.parse(localStorage.getItem(ALERT_STORAGE_KEY) ?? "null") as Partial<AlertPreferences> | null;
      if (storedAlerts) setAlerts({ ...DEFAULT_ALERTS, ...storedAlerts });
    } catch { localStorage.removeItem(ALERT_STORAGE_KEY); }
    try {
      const storedMetrics = JSON.parse(localStorage.getItem(METRICS_STORAGE_KEY) ?? "null") as MetricId[] | null;
      if (Array.isArray(storedMetrics)) setMetrics(storedMetrics.slice(0, 5));
    } catch { localStorage.removeItem(METRICS_STORAGE_KEY); }

    fetch("/api/archive")
      .then((response) => response.json())
      .then((payload: { days?: ArchiveDay[] }) => setArchiveDays(payload.days ?? []))
      .catch(() => setArchiveDays([]));

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

  const toggleMetric = (id: MetricId, checked: boolean) => {
    setMetrics((current) => checked ? [...current, id].slice(0, 5) : current.filter((metric) => metric !== id));
  };

  const saveMetrics = () => {
    localStorage.setItem(METRICS_STORAGE_KEY, JSON.stringify(metrics));
    setMetricsSaved(true);
    window.setTimeout(() => setMetricsSaved(false), 2200);
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

      <section className="settings-card metric-settings-card">
        <div className="settings-icon"><Gauge size={23} /></div>
        <p className="eyebrow">DASHBOARD</p>
        <h2>Top data boxes</h2>
        <p className="settings-intro">Choose up to five live metrics for the top of the tracker. Clear every option to hide the data strip completely.</p>
        <div className="metric-options">
          {METRIC_OPTIONS.map((option) => {
            const checked = metrics.includes(option.id);
            const disabled = !checked && metrics.length >= 5;
            return (
              <label key={option.id} className={disabled ? "disabled" : ""}>
                <Checkbox checked={checked} disabled={disabled} onCheckedChange={(value) => toggleMetric(option.id, value === true)} />
                <span><strong>{option.label}</strong><small>{option.description}</small></span>
              </label>
            );
          })}
        </div>
        <div className="settings-actions">
          <Button onClick={saveMetrics}>{metricsSaved ? <><Check size={15} /> Saved</> : `Save data boxes (${metrics.length}/5)`}</Button>
        </div>
      </section>

      <section className="settings-card archive-settings-card">
        <div className="settings-icon"><Archive size={23} /></div>
        <p className="eyebrow">DAILY ARCHIVE</p>
        <h2>Perimeter downloads</h2>
        <p className="settings-intro">The latest active perimeter set is captured every day. The newest 20 daily files are retained; the oldest is removed when the next daily file is saved.</p>
        {archiveDays.length ? (
          <div className="archive-list">
            {archiveDays.map((day) => (
              <div key={day.date}>
                <span><strong>{day.date}</strong><small>{day.perimeterCount} perimeter{day.perimeterCount === 1 ? "" : "s"}</small></span>
                <Button asChild size="sm" variant="outline"><a href={`/api/archive?date=${day.date}&format=kml`}><Download size={14} /> KML</a></Button>
                <Button asChild size="sm" variant="ghost"><a href={`/api/archive?date=${day.date}&format=geojson`}><Download size={14} /> GeoJSON</a></Button>
              </div>
            ))}
          </div>
        ) : <p className="archive-empty">Today’s first daily perimeter archive will appear here after the capture completes.</p>}
      </section>
    </main>
  );
}
