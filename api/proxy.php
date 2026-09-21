<?php
$DEFAULT_REFERER = "https://taraftarium24bjk17.com/";
$DEFAULT_ORIGIN  = "https://taraftarium24bjk17.com";
$TIMEOUT         = 25;

$SRC_MAP = [
    'zirve' => 'https://19x.t24hls11.cfd/zirve/mono.m3u8',
];

header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: GET, HEAD, OPTIONS");
header("Access-Control-Allow-Headers: *");
header("Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges");
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

function isManifest($url) {
    return substr(strtolower(explode('?', $url)[0]), -5) === '.m3u8';
}

function forwardXHeaders() {
    $out = [];
    foreach ($_SERVER as $k => $v) {
        if (strpos($k, 'HTTP_X_VX_') === 0) {
            $name = 'X-VX-' . str_replace('_', '-', substr($k, 10));
            $out[] = $name . ': ' . $v;
        }
    }
    return $out;
}

function buildHeaders($referer, $origin, $range = null) {
    $ua = $_SERVER['HTTP_USER_AGENT'] ?? '';
    if (strlen($ua) < 15) {
        $ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
    }
    $h = [
        "User-Agent: " . $ua,
        "Accept: */*",
        "Accept-Language: tr-TR,tr;q=0.9,en;q=0.8",
        "Referer: " . $referer,
        "Origin: "  . $origin,
        "Connection: close",
    ];
    $h = array_merge($h, forwardXHeaders());
    if ($range) $h[] = "Range: " . $range;
    return $h;
}

function curlFetch($url, $headers, $range = null) {
    global $TIMEOUT;
    $ch = curl_init();
    $opts = [
        CURLOPT_URL            => $url,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS      => 8,
        CURLOPT_TIMEOUT        => $TIMEOUT,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_SSL_VERIFYPEER => false,
        CURLOPT_SSL_VERIFYHOST => false,
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_ENCODING       => "",
        CURLOPT_HEADER         => true,
    ];
    if ($range) $opts[CURLOPT_RANGE] = $range;
    curl_setopt_array($ch, $opts);
    $response    = curl_exec($ch);
    $status      = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $contentType = curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
    $headerSize  = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
    $error       = curl_error($ch);
    curl_close($ch);
    $rawHeaders = substr($response, 0, $headerSize);
    $body       = substr($response, $headerSize);
    $respHeaders = [];
    foreach (explode("\n", $rawHeaders) as $line) {
        if (strpos($line, ':') !== false) {
            list($k, $v) = explode(':', $line, 2);
            $respHeaders[strtolower(trim($k))] = trim($v);
        }
    }
    return compact('body','status','contentType','error','respHeaders');
}

function makeAbsolute($url, $baseOrigin, $baseDir) {
    if (preg_match('#^https?://#i', $url)) return $url;
    if (substr($url, 0, 2) === '//')       return 'https:' . $url;
    if (substr($url, 0, 1) === '/')        return $baseOrigin . $url;
    $parts = [];
    foreach (explode('/', $baseDir . $url) as $p) {
        if ($p === '..') array_pop($parts);
        elseif ($p !== '.' && $p !== '') $parts[] = $p;
    }
    return $baseOrigin . '/' . implode('/', $parts);
}

$action = $_GET['action'] ?? 'info';

if (isset($_GET['src']) && isset($SRC_MAP[$_GET['src']])) {
    $target = $SRC_MAP[$_GET['src']];
} else {
    $target = $_GET['url'] ?? '';
}

$ref  = $_GET['referer'] ?? $DEFAULT_REFERER;
$orig = $_GET['origin']  ?? $DEFAULT_ORIGIN;

if ($action === 'health') { header("Content-Type: text/plain"); echo "OK"; exit; }
if ($target === '') { http_response_code(400); header("Content-Type: text/plain"); echo "Missing url"; exit; }

$host    = $_SERVER['HTTP_HOST'];
$scheme  = 'https';
$baseUrl = "$scheme://$host";

if ($action === 'ts') {
    $range = $_SERVER['HTTP_RANGE'] ?? null;
    $res = curlFetch($target, buildHeaders($ref, $orig, $range), $range);
    if ($res['status'] < 200 || $res['status'] >= 400) {
        http_response_code($res['status'] ?: 502);
        header("Content-Type: text/plain");
        echo "Upstream {$res['status']}"; exit;
    }
    http_response_code($range ? 206 : 200);
    header("Content-Type: video/mp2t");
    header("Accept-Ranges: bytes");
    header("Cache-Control: public, max-age=10");
    if (isset($res['respHeaders']['content-range']))
        header("Content-Range: " . $res['respHeaders']['content-range']);
    header("Content-Length: " . strlen($res['body']));
    echo $res['body']; exit;
}

if ($action === 'hls') {
    $res = curlFetch($target, buildHeaders($ref, $orig));
    if ($res['status'] < 200 || $res['status'] >= 300) {
        http_response_code($res['status'] ?: 502);
        header("Content-Type: text/plain");
        echo "Upstream {$res['status']}"; exit;
    }
    $text = ltrim($res['body'], "\xEF\xBB\xBF \t\n\r");
    if (strpos($text, '#EXTM3U') !== 0) {
        header("Content-Type: text/plain");
        echo "Not a manifest"; exit;
    }
    $p = parse_url($target);
    $baseOrigin = ($p['scheme'] ?? 'https') . '://' . ($p['host'] ?? '')
                . (isset($p['port']) ? ':' . $p['port'] : '');
    $basePath = $p['path'] ?? '/';
    $baseDir  = substr($basePath, 0, strrpos($basePath, '/') + 1);
    $segRef  = $baseOrigin . '/';
    $segOrig = $baseOrigin;
    $segQS = '&referer=' . urlencode($segRef) . '&origin=' . urlencode($segOrig);
    $out = [];
    foreach (explode("\n", $text) as $line) {
        $t = rtrim($line, "\r\n");
        if ($t === '') { $out[] = ''; continue; }
        if ($t[0] === '#') {
            if (strpos($t, 'URI="') !== false) {
                $t = preg_replace_callback('/URI="([^"]+)"/',
                    function($m) use ($baseOrigin,$baseDir,$baseUrl,$segQS) {
                        $abs = makeAbsolute($m[1], $baseOrigin, $baseDir);
                        if (isManifest($abs)) {
                            return 'URI="' . $baseUrl . '/?action=hls&url=' . urlencode($abs) . $segQS . '"';
                        } else {
                            return 'URI="' . $baseUrl . '/?action=ts&url=' . urlencode($abs) . $segQS . '"';
                        }
                    }, $t);
            }
            $out[] = $t; continue;
        }
        $abs = makeAbsolute($t, $baseOrigin, $baseDir);
        if (isManifest($abs)) {
            $out[] = $baseUrl . '/?action=hls&url=' . urlencode($abs) . $segQS;
        } else {
            $out[] = $baseUrl . '/?action=ts&url='  . urlencode($abs) . $segQS;
        }
    }
    $manifest = implode("\r\n", $out) . "\r\n";
    header("Content-Type: application/vnd.apple.mpegurl");
    header("Content-Length: " . strlen($manifest));
    header("Cache-Control: no-cache, no-store");
    echo $manifest; exit;
}

if ($action === 'debug') {
    $res = curlFetch($target, buildHeaders($ref, $orig));
    header("Content-Type: text/plain; charset=utf-8");
    echo "Status: {$res['status']}\n";
    echo "Type: {$res['contentType']}\n";
    echo "Ref: {$ref}\n";
    echo "Error: {$res['error']}\n\n";
    echo substr($res['body'], 0, 1500);
    exit;
}

http_response_code(404); header("Content-Type: text/plain"); echo "Unknown";
