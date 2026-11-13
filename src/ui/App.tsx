import { HL1060_BED } from '../model/bed';

export function App() {
  return (
    <div className="app">
      <header className="app-header">
        <h1>LaserAlfredo</h1>
        <span className="app-bed" data-testid="bed-size">
          Bed {HL1060_BED.widthMm} × {HL1060_BED.heightMm} mm
        </span>
      </header>
      <main className="app-main">
        <p>Import and view arrives next (milestone 1).</p>
      </main>
    </div>
  );
}
