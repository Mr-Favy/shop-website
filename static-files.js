import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(projectRoot, 'public');
const pageRoutes = new Map([
  ['/', path.join(projectRoot, 'pages', 'company-home.html')],
  ['/index.html', path.join(projectRoot, 'index.html')],
  ['/zammath-consulting/', path.join(projectRoot, 'pages', 'company-home.html')],
  ['/zammath-consulting', path.join(projectRoot, 'pages', 'company-home.html')],
  ['/about-us/', path.join(projectRoot, 'pages', 'about-us.html')],
  ['/about-us', path.join(projectRoot, 'pages', 'about-us.html')],
  ['/our-services/', path.join(projectRoot, 'pages', 'our-services.html')],
  ['/our-services', path.join(projectRoot, 'pages', 'our-services.html')],
  ['/our-businesses/', path.join(projectRoot, 'pages', 'our-businesses.html')],
  ['/our-businesses', path.join(projectRoot, 'pages', 'our-businesses.html')],
  ['/contact-us/', path.join(projectRoot, 'pages', 'contact-us.html')],
  ['/contact-us', path.join(projectRoot, 'pages', 'contact-us.html')],
  ['/zamac-fuds/', path.join(projectRoot, 'zamac-fuds', 'index.html')],
  ['/zamac-fuds', path.join(projectRoot, 'zamac-fuds', 'index.html')],
]);

function isWithin(parent, candidate) {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

export function resolveStaticFile(requestPath) {
  let pathname;
  try {
    pathname = decodeURIComponent(requestPath);
  } catch {
    return { status: 400 };
  }
  if (pathname.includes('\0') || pathname.includes('\\')) return { status: 403 };
  const pageFile = pageRoutes.get(pathname);
  if (pageFile) {
    if (!existsSync(pageFile) || !statSync(pageFile).isFile()) return { status: 404 };
    try {
      const resolvedPage = realpathSync(pageFile);
      // Page routes are exact files. Refuse symlinks so an allowlisted path
      // cannot be redirected to another project file.
      if (resolvedPage !== pageFile) return { status: 403 };
      return { status: 200, file: resolvedPage };
    } catch {
      return { status: 404 };
    }
  }
  if (!pathname.startsWith('/assets/')) return { status: 404 };

  const segments = pathname.slice('/assets/'.length).split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.startsWith('.'))) {
    return { status: 403 };
  }
  const candidate = path.resolve(publicRoot, 'assets', ...segments);
  if (!isWithin(publicRoot, candidate) || !existsSync(candidate) || !statSync(candidate).isFile()) {
    return { status: 404 };
  }
  try {
    const resolvedPublicRoot = realpathSync(publicRoot);
    const resolvedFile = realpathSync(candidate);
    if (!isWithin(resolvedPublicRoot, resolvedFile)) return { status: 403 };
    return { status: 200, file: resolvedFile };
  } catch {
    return { status: 404 };
  }
}
