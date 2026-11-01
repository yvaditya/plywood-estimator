import runtime from 'virtual:package-runtime';
import css from './packageStyle.css?inline';
import { buildPackageHtml, type PackageLayout } from './packageHtml';
import type { PackageData } from './packageData';

export function downloadPackage(data: PackageData, layout: PackageLayout) {
  const html = buildPackageHtml(data, layout, runtime, css);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${data.jobName.replace(/[^a-z0-9_-]+/gi, '_').toLowerCase() || 'workshop_job'}_${layout}.html`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
