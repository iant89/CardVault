import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TrainerPythonPanel } from './OcrLabPage';

const steps = ['Virtual environment', 'PyTorch (CPU build)', 'Trainer packages'];
const base = { steps, venv: '/data/storage/ocr/venv', configured: false, manual: 'bash scripts/ocr-python.sh', setupScript: '/app/scripts/ocr-python.sh', log: [] as string[] };
const props = (py: unknown) => ({ py: { ...base, ...(py as object) } as never, busy: false, trainActive: false, act: async () => {} });
const text = (py: unknown) => renderToStaticMarkup(createElement(TrainerPythonPanel, props(py))).replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

describe('trainer Python panel', () => {
  it('offers the setup when no interpreter is installed', () => {
    const t = text({ status: 'missing', error: 'No Python with torch and pillow found (tried the trainer venv, python3, python). Press “Set up the OCR trainer” above, run bash scripts/ocr-python.sh on this server, or set OCR_TRAIN_PYTHON.' });
    expect(t).toContain('Not installed');
    expect(t).toContain('Set up the OCR trainer');
    expect(t).toContain('Run it yourself over SSH');
    expect(t).toContain('bash scripts/ocr-python.sh');
  });

  it('shows the interpreter and a check button when ready', () => {
    const t = text({ status: 'ready', python: '/data/storage/ocr/venv/bin/python', finishedAt: new Date().toISOString() });
    expect(t).toContain('/data/storage/ocr/venv/bin/python');
    expect(t).toContain('Check again');
    expect(t).not.toContain('Set up the OCR trainer');
  });

  it('shows which step is running during setup', () => {
    const t = text({ status: 'installing', step: 2, log: ['==> installing PyTorch'] });
    expect(t).toContain('Installing: PyTorch (CPU build)');
    expect(t).toContain('✓ Virtual environment');
    expect(t).toContain('• PyTorch (CPU build)');
    expect(t).toContain('Show setup log');
  });

  it('explains a failed setup without hiding the log', () => {
    const t = text({ status: 'failed', step: 2, error: 'The setup could not finish. The log above shows why', log: ['ERROR: No matching distribution found for torch'] });
    expect(t).toContain('The setup could not finish');
    expect(t).toContain('Show setup log');
  });

  it('says what happens before it is set up, with the size and location', () => {
    const t = text({ status: 'unknown' });
    expect(t).toContain('Not checked yet');
    expect(t).toContain('Set up the OCR trainer');
  });

  it('disables the button while training runs', () => {
    const html = renderToStaticMarkup(createElement(TrainerPythonPanel, { ...props({ status: 'ready', python: '/x' }), trainActive: true }));
    expect(html).toMatch(/disabled/);
  });
});
