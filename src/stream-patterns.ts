// Copied from artifacts/api-server/src/streamPatterns.ts
// URLs matching these patterns are piped (streamed) rather than buffered.

export const streamPatterns: RegExp[] = [
    /pixeldrain\.dev|pixeldra\.in/,
    /hub\.(raj\.lat|toxix\.buzz|oreao-cdn\.buzz)/,
    /wasabisys\.com/,
    /hakunaymatata\.com/,
    /streamflixserver\.site|tripplestream\.online/,
    /illimitableinkwell\.site/,
    /frostcomet5\.pro/,
    /(epimetheus63|earth14|pandora20)\.workers\.dev/,
    /tiktokcdn\.com/,
    /\/content\/[^?\s]+\/page-\d+\.html(?:\?|$)/,
    /trendimovies\.com\/tgstream\/stream/,
    // Exclude .m3u8 — manifests from cdn.mewstream.buzz must go through the
    // buffered path so relative variant URLs get rewritten before HLS.js sees them.
    /\.(mewstream|sparkora)\.buzz\/(?!.*\.m3u8)/,
    /embed\.animecurx\.tech.*\.html/,
    // MegaPlay's newer segment CDN — segments disguised as .jpg/.html/.js/etc.
    // Manifests live on cdn.mewstream.buzz (different host), so this is safe.
    /cloudvideo\.lat/,
    // default video extensions
    /\.mp4($|\?)/,
    /\.mkv($|\?)/,
    /\.webm($|\?)/,
    /\.avi($|\?)/,
    /\.mov($|\?)/,
];
