// Proxy service — ported from @omss/framework's ProxyService.
// Handles manifest rewriting and response forwarding.
import { streamPatterns } from './stream-patterns.js';

export interface ProxyData {
    url: string;
    headers?: Record<string, string>;
}

function shouldStream(url: string): boolean {
    return streamPatterns.some((p) => p.test(url));
}

function getMimeType(url: string): string {
    if (/\.vtt$/i.test(url)) return 'text/vtt';
    if (/\.srt$/i.test(url)) return 'text/plain';
    if (/\.(ass|ssa)$/i.test(url)) return 'text/plain';
    if (/\.m3u8/i.test(url)) return 'application/x-mpegURL';
    if (/\.mpd/i.test(url)) return 'application/dash+xml';
    if (/\.mp4/i.test(url)) return 'video/mp4';
    if (/\.mkv/i.test(url)) return 'video/x-matroska';
    if (/\.webm/i.test(url)) return 'video/webm';
    if (/\.ts($|\?)/i.test(url)) return 'video/mp2t';
    return 'application/octet-stream';
}

function isManifestFile(contentType: string, url: string): boolean {
    const TEXT_RE = /^(text\/.*|application\/(.*\+xml|.*\+json|json|xml|javascript|yaml|x-yaml|x-www-form-urlencoded))(;.*)?$/i;
    const isTextLike = TEXT_RE.test(contentType);
    return (
        (isTextLike ||
            /application\/(vnd\.apple\.mpegurl|x-mpegurl|dash\+xml)/i.test(contentType) ||
            /\.m3u8(\?.*)?$/i.test(url) ||
            /\.mpd(\?.*)?$/i.test(url)) &&
        !/\.(vtt|srt|ass|ssa|ttml)(\?.*)?$/i.test(url)
    );
}

function resolveUrl(baseUrl: string, targetUrl: string): string {
    if (targetUrl.startsWith('http://') || targetUrl.startsWith('https://')) return targetUrl;
    try {
        const b = new URL(baseUrl);
        if (targetUrl.startsWith('//')) return `${b.protocol}${targetUrl}`;
        if (targetUrl.startsWith('/')) return `${b.protocol}//${b.host}${targetUrl}`;
        const baseDir = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
        return new URL(targetUrl, baseDir).toString();
    } catch {
        const baseDir = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
        return baseDir + targetUrl;
    }
}

function makeProxyUrl(url: string, headers: Record<string, string> | undefined, proxyBase: string): string {
    const data = JSON.stringify({ url, headers: headers ?? {} });
    return `${proxyBase}/v1/proxy?data=${encodeURIComponent(data)}`;
}

function isUrlLine(line: string): boolean {
    if (/^https?:\/\//.test(line) || line.startsWith('//') || line.startsWith('/')) return true;
    return (
        line.includes('.ts') ||
        line.includes('.m3u8') ||
        line.includes('.mp4') ||
        line.includes('.m4s') ||
        line.includes('.webm') ||
        line.includes('.vtt') ||
        line.includes('.key') ||
        line.includes('/') ||
        /^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+/.test(line)
    );
}

function rewriteTagAttributes(line: string, baseUrl: string, headers: Record<string, string> | undefined, proxyBase: string): string {
    return line.replace(/URI\s*=\s*["']([^"']+)["']/gi, (_match, capturedUrl) => {
        const resolved = resolveUrl(baseUrl, capturedUrl);
        const proxied = makeProxyUrl(resolved, headers, proxyBase);
        const quote = _match.includes('"') ? '"' : "'";
        return `URI=${quote}${proxied}${quote}`;
    });
}

function rewriteManifest(content: string, baseUrl: string, headers: Record<string, string> | undefined, proxyBase: string): string {
    const lines = content.split('\n');
    const out: string[] = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (line.startsWith('#') && /URI\s*=\s*["']([^"']+)["']/i.test(line)) {
            out.push(rewriteTagAttributes(line, baseUrl, headers, proxyBase));
            continue;
        }
        if (line.startsWith('#') || trimmed === '') {
            out.push(line);
            continue;
        }
        if (isUrlLine(trimmed)) {
            const resolved = resolveUrl(baseUrl, trimmed);
            const proxied = makeProxyUrl(resolved, headers, proxyBase);
            const indent = line.match(/^\s*/)?.[0] ?? '';
            out.push(indent + proxied);
        } else {
            out.push(line);
        }
    }
    return out.join('\n');
}

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36';

export async function handleProxy(encodedData: string, rangeHeader: string | null, proxyBase: string): Promise<Response> {
    let proxyData: ProxyData;
    try {
        proxyData = JSON.parse(decodeURIComponent(encodedData)) as ProxyData;
        if (!proxyData.url) throw new Error('missing url');
    } catch {
        return new Response(JSON.stringify({ error: { code: 'INVALID_PARAMETER', message: 'Invalid data parameter' } }), {
            status: 400, headers: { 'Content-Type': 'application/json' },
        });
    }

    const upstreamHeaders: Record<string, string> = {
        'User-Agent': proxyData.headers?.['User-Agent'] ?? DEFAULT_UA,
        ...(proxyData.headers ?? {}),
        ...(rangeHeader ? { Range: rangeHeader } : {}),
    };

    const CORS = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
    };

    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30_000);

        const upstream = await fetch(proxyData.url, {
            headers: upstreamHeaders,
            redirect: 'follow',
            signal: controller.signal,
        });
        clearTimeout(timer);

        const contentType = upstream.headers.get('content-type') ?? getMimeType(proxyData.url);

        // Stream large video files directly without buffering
        if (shouldStream(proxyData.url)) {
            return new Response(upstream.body, {
                status: upstream.status,
                headers: {
                    'Content-Type': contentType,
                    'Cache-Control': upstream.headers.get('cache-control') ?? 'public, max-age=7200',
                    'Accept-Ranges': 'bytes',
                    ...(upstream.headers.get('content-length') ? { 'Content-Length': upstream.headers.get('content-length')! } : {}),
                    ...(upstream.headers.get('content-range') ? { 'Content-Range': upstream.headers.get('content-range')! } : {}),
                    ...CORS,
                },
            });
        }

        // Buffer and potentially rewrite manifests
        const body = await upstream.arrayBuffer();
        let responseBody: Uint8Array | string;

        if (isManifestFile(contentType, proxyData.url)) {
            const text = new TextDecoder().decode(body);
            const rewritten = rewriteManifest(text, proxyData.url, proxyData.headers, proxyBase);
            responseBody = rewritten;
        } else {
            responseBody = new Uint8Array(body);
        }

        return new Response(responseBody, {
            status: upstream.status,
            headers: {
                'Content-Type': contentType,
                'Cache-Control': upstream.headers.get('cache-control') ?? 'public, max-age=7200',
                'Accept-Ranges': 'bytes',
                'Content-Disposition': 'inline',
                ...CORS,
            },
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        return new Response(JSON.stringify({ error: { code: 'PROXY_ERROR', message: msg } }), {
            status: 502, headers: { 'Content-Type': 'application/json', ...CORS },
        });
    }
}
