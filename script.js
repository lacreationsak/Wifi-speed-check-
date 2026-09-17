/* ===========================================================================
   Signal — Wi-Fi Speed Check
   ---------------------------------------------------------------------------
   Measurement runs entirely in the browser against speed.cloudflare.com.
   Nothing is sent anywhere else, and results live in localStorage only.

   Why the download and upload stages open several connections at once:
   a single TCP stream is limited by its congestion window and by the
   round-trip time to the edge, so on anything faster than roughly
   100 Mbps one stream measures the connection's *latency*, not its
   capacity, and reports a small fraction of the real line rate. Every
   serious speed test opens a handful of parallel streams and adds the
   throughput together. That is what the stream counts below are for.
   =========================================================================== */

const ENDPOINT = "https://speed.cloudflare.com";

const TEST_CONFIG = {
    // Latency
    pingWarmups: 1,
    pingSamples: 10,

    // Download: parallel streams, each asking for a large body. The run is
    // ended by DURATION rather than by the byte count, so a slow line simply
    // transfers less instead of hanging for a minute.
    downloadStreams: 4,
    downloadBytesPerStream: 60_000_000,
    downloadDurationMs: 9_000,

    // Upload: fewer streams, smaller bodies. Upstream is usually the narrower
    // direction, and the payload has to be generated in memory first.
    uploadStreams: 3,
    uploadBytesPerStream: 6_000_000,
    uploadDurationMs: 8_000,

    // A sample every 120 ms keeps the dial lively without flooding it.
    sampleIntervalMs: 120,

    // TCP slow start makes the first moment of any transfer unrepresentative.
    // Samples before this point still drive the animation, but are left out
    // of the final figure.
    warmupMs: 1_200
};

// A linear 0-1000 scale would crowd every ordinary connection into the first
// few degrees of the dial, so the arc is stretched logarithmically: the busy
// 0-100 range gets most of the sweep, and gigabit still has somewhere to go.
const METER_MAX = 1000;
const METER_SWEEP = 276;

/* ---------------------------------------------------------------------------
   What a browser will and will not tell you about the connection

   An earlier version of this file printed `navigator.connection.effectiveType`
   into the UI as "3G NETWORK". The value was real; it was being read as
   something it is not.

     connection.effectiveType   A PERFORMANCE TIER, never a radio generation.
                                Only ever "slow-2g" | "2g" | "3g" | "4g".
                                Chrome derives it from a rolling estimate of
                                round-trip time and throughput, and the scale
                                STOPS at "4g". Gigabit fibre and an average
                                LTE phone both report "4g"; a busy or distant
                                Wi-Fi router reports "3g".

     connection.type            The real transport: "wifi" | "ethernet" |
                                "cellular" | "bluetooth" | "wimax" | "none" |
                                "other" | "unknown". Implemented only in
                                Chromium on Android and ChromeOS. Undefined on
                                desktop Chrome; Firefox and Safari do not ship
                                the Network Information API at all.

     connection.downlink        Rounded, and capped at 10 Mbps by Chrome, so it
                                cannot grade a fast link. Used here as a hint,
                                never to pick a link class.

   No browser exposes the Wi-Fi band (2.4 / 5 / 6 GHz), the Wi-Fi generation,
   the SSID, the negotiated PHY rate, or the cellular generation (LTE vs 5G
   NR). That is deliberate: those values are a strong device fingerprint. A
   native app can read them; a web page cannot.

   So: report the transport as fact when the browser provides it, say plainly
   when it does not, and infer a link class from the measurement afterwards —
   always phrased as a floor, because throughput is capped by the slowest hop
   in the path rather than by the radio.
   --------------------------------------------------------------------------- */

const CONNECTION_API =
    navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;

const TRANSPORTS = {
    wifi: { label: "Wi‑Fi", scope: "WLAN", certain: true, note: "Reported directly by the browser." },
    ethernet: { label: "Ethernet", scope: "LAN", certain: true, note: "Wired. Reported directly by the browser." },
    cellular: { label: "Cellular", scope: "WWAN", certain: true, note: "Mobile data. Reported directly by the browser." },
    bluetooth: { label: "Bluetooth tether", scope: "PAN", certain: true, note: "Shared from another device over Bluetooth." },
    wimax: { label: "WiMAX", scope: "WWAN", certain: true, note: "Reported directly by the browser." },
    none: { label: "No network", scope: "", certain: true, note: "The browser reports no active connection." }
};

// Thresholds are measured download in Mbps, and describe the *minimum* link
// that could have carried it — never the maximum. A Wi-Fi 6 router behind a
// 40 Mbps broadband line measures 40 Mbps, so a floor is the only sound claim.
const LINK_CLASSES = {
    wifi: [
        [480, "Wi‑Fi 6 / 6E class or better", "Only a 5 GHz or 6 GHz link on Wi‑Fi 6-era hardware sustains this."],
        [170, "Wi‑Fi 5 class (5 GHz) or better", "Comfortably past what a 2.4 GHz link can carry."],
        [55, "Wi‑Fi 4 / 5 class", "Could be a 5 GHz link, or a strong 2.4 GHz one."],
        [14, "2.4 GHz class, or a weak 5 GHz link", "Also what a good link behind a slower broadband plan looks like."],
        [0, "Constrained Wi‑Fi link", "Weak signal, heavy congestion, or a slow line behind the router."]
    ],
    ethernet: [
        [700, "Gigabit class", "Sustaining this needs a gigabit port end to end."],
        [180, "Gigabit port, slower line", "The cable is not the limit here — the broadband plan is."],
        [60, "100 Mbps class", "Consistent with a Fast Ethernet port or a 100 Mbps plan."],
        [0, "Constrained wired link", "Well under what any modern Ethernet port can carry."]
    ],
    cellular: [
        [120, "5G class (NR)", "LTE rarely holds this on a real device; this looks like 5G."],
        [45, "4G+ / LTE‑Advanced class", "Carrier aggregation territory, or a lightly loaded 5G cell."],
        [8, "4G / LTE class", "Ordinary LTE throughput."],
        [1.2, "3G class", "Well below LTE — either 3G, or an LTE cell that is throttled or congested."],
        [0, "2G class, or throttled", "Barely moving. Often a data cap that has been reached."]
    ],
    unknown: [
        [480, "Gigabit-class path", "Ethernet, or Wi‑Fi 6-era hardware on a fast line."],
        [170, "Fast broadband path", "Ethernet or a 5 GHz Wi‑Fi link."],
        [55, "Mid-tier broadband path", ""],
        [14, "Modest path", ""],
        [0, "Constrained path", ""]
    ]
};

const EFFECTIVE_TYPES = {
    "slow-2g": "Very poor tier",
    "2g": "Poor tier",
    "3g": "Moderate tier",
    "4g": "Good tier (top of the scale)"
};

function isMobileDevice() {
    if (navigator.userAgentData && typeof navigator.userAgentData.mobile === "boolean") {
        return navigator.userAgentData.mobile;
    }

    return /Android|iPhone|iPad|iPod|Windows Phone|Mobile/i.test(navigator.userAgent || "");
}

function readTransport() {
    const reported = CONNECTION_API && CONNECTION_API.type;

    if (reported && Object.prototype.hasOwnProperty.call(TRANSPORTS, reported)) {
        return Object.assign({ key: reported }, TRANSPORTS[reported]);
    }

    if (isMobileDevice()) {
        return {
            key: "unknown",
            label: "Wi‑Fi or cellular",
            scope: "WLAN / WWAN",
            certain: false,
            note: "This browser does not expose which one. On a phone it is one of the two."
        };
    }

    return {
        key: "unknown",
        label: "Wi‑Fi or Ethernet",
        scope: "WLAN / LAN",
        certain: false,
        note: "This browser does not expose which one. Chrome and Edge on Android and ChromeOS do; desktop browsers do not."
    };
}

// Jitter separates a cable from a radio far better than raw throughput does:
// a wired link is boringly consistent, Wi-Fi wobbles a little, a mobile radio
// wobbles a lot. Only consulted when the browser refused to name the transport.
function guessTransportFromMetrics(ping, jitter) {
    if (jitter <= 2 && ping <= 25) {
        return "Very steady — behaves like a wired link.";
    }

    if (jitter <= 9 && ping <= 70) {
        return "Mild variance — behaves like Wi‑Fi.";
    }

    return "High variance — behaves like a mobile radio or a congested link.";
}

function classifyLink(transportKey, download, ping, jitter) {
    const table = LINK_CLASSES[transportKey] || LINK_CLASSES.unknown;
    const speed = Number.isFinite(download) ? download : 0;
    const match = table.find(([threshold]) => speed >= threshold) || table[table.length - 1];
    const parts = [];

    if (match[2]) {
        parts.push(match[2]);
    }

    if (transportKey === "unknown") {
        parts.push(guessTransportFromMetrics(ping, jitter));
    }

    return { title: match[1], note: parts.join(" ") };
}

/* ========================================================================= */

function initializeSpeedTest() {
    const state = {
        controller: null,
        testing: false,
        lastResult: null,
        render: { frame: null, lastFrame: null, lastPaint: null },
        meter: { currentValue: 0, targetValue: 0, renderedValue: null, renderedAngle: null },
        metrics: {
            download: { currentValue: 0, targetValue: 0, renderedValue: null },
            upload: { currentValue: 0, targetValue: 0, renderedValue: null },
            ping: { currentValue: 0, targetValue: 0, renderedValue: null },
            jitter: { currentValue: 0, targetValue: 0, renderedValue: null }
        }
    };

    // The dial's conic gradient is expensive to repaint. Cap visual updates at
    // 30 per second rather than repainting on every animation frame.
    const RENDER_INTERVAL = 1000 / 30;

    const elements = {
        button: document.querySelector("#testButton"),
        buttonText: document.querySelector("#buttonText"),
        stage: document.querySelector("#stageCopy"),
        meterDial: document.querySelector("#meterDial"),
        meterRing: document.querySelector("#meterRing"),
        meterPhase: document.querySelector("#meterPhase"),
        meterNumber: document.querySelector("#meterNumber"),
        download: document.querySelector("#downloadValue"),
        upload: document.querySelector("#uploadValue"),
        ping: document.querySelector("#pingValue"),
        jitter: document.querySelector("#jitterValue"),
        status: document.querySelector("#connectionStatus"),
        statusDot: document.querySelector("#statusDot"),
        history: document.querySelector("#historyList"),
        connectionType: document.querySelector("#connectionType"),
        clearHistory: document.querySelector("#clearHistory"),
        exportHistory: document.querySelector("#exportHistory"),
        resultSummary: document.querySelector("#resultSummary"),
        recommendationTitle: document.querySelector("#recommendationTitle"),
        recommendationCopy: document.querySelector("#recommendationCopy"),
        copyResult: document.querySelector("#copyResult")
    };

    const missingElements = Object.entries(elements)
        .filter(([, element]) => !element)
        .map(([name]) => name);

    if (missingElements.length) {
        console.error("Missing required HTML elements:", missingElements.join(", "));
        return;
    }

    // Deliberately outside `elements`: the check above aborts the whole app
    // when something is missing, and these readouts are informational.
    const readouts = {
        link: document.querySelector("#connectionLink"),
        connectionTypeNote: document.querySelector("#connectionTypeNote"),
        linkClass: document.querySelector("#linkClass"),
        linkClassNote: document.querySelector("#linkClassNote"),
        browserReport: document.querySelector("#browserReport"),
        browserReportNote: document.querySelector("#browserReportNote"),
        signalStrength: document.querySelector("#signalStrength"),
        signalStrengthNote: document.querySelector("#signalStrengthNote"),
        signalBars: document.querySelector("#signalBars"),
        gamingCard: document.querySelector("#gamingSummary"),
        gamingTitle: document.querySelector("#gamingTitle"),
        gamingCopy: document.querySelector("#gamingCopy"),
        gamingPing: document.querySelector("#gamingPing"),
        gamingJitter: document.querySelector("#gamingJitter"),
        gamingLoss: document.querySelector("#gamingLoss"),
        gamingBadge: document.querySelector("#gamingBadge")
    };

    const cockpit = document.querySelector("#heroCockpit");
    const statCards = new Map(
        Array.from(document.querySelectorAll(".stat-card[data-stat]"))
            .map((card) => [card.dataset.stat, card])
    );

    /* ------------------------------------------------------------ helpers */

    function setText(element, text) {
        if (element) {
            element.textContent = text;
        }
    }

    function setMarkup(element, markup) {
        if (element) {
            element.innerHTML = markup;
        }
    }

    function escapeHtml(value) {
        return String(value).replace(/[&<>"]/g, (character) => (
            { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[character]
        ));
    }

    function formatNumber(value) {
        if (!Number.isFinite(value)) {
            return "—";
        }

        // An idle dial reading "0.00" looks like a broken precision setting
        // rather than a resting state.
        if (value === 0) {
            return "0";
        }

        if (value >= 100) {
            return value.toFixed(0);
        }

        if (value >= 10) {
            return value.toFixed(1);
        }

        return value.toFixed(2);
    }

    function createAbortError() {
        return new DOMException("Test stopped", "AbortError");
    }

    function isAbort(error) {
        return Boolean(error) && (error.name === "AbortError" || error.name === "TimeoutError");
    }

    function median(values) {
        if (!values.length) {
            return Number.NaN;
        }

        const sorted = [...values].sort((a, b) => a - b);
        const middle = Math.floor(sorted.length / 2);

        return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    }

    // Mean absolute difference between consecutive samples — the standard
    // definition of packet jitter, and more useful here than variance because
    // it tracks how much the link wobbles from moment to moment.
    function meanDeviation(readings) {
        if (readings.length < 2) {
            return 0;
        }

        const total = readings
            .slice(1)
            .reduce((sum, value, index) => sum + Math.abs(value - readings[index]), 0);

        return total / (readings.length - 1);
    }

    function delay(ms, signal) {
        return new Promise((resolve, reject) => {
            function onAbort() {
                clearTimeout(timer);
                reject(createAbortError());
            }

            const timer = setTimeout(() => {
                signal.removeEventListener("abort", onAbort);
                resolve();
            }, ms);

            if (signal.aborted) {
                onAbort();
                return;
            }

            signal.addEventListener("abort", onAbort, { once: true });
        });
    }

    /* ------------------------------------------------------ dial rendering */

    function meterAngle(value) {
        const speed = Math.max(0, Number(value) || 0);
        const fraction = Math.log10(1 + speed / 2) / Math.log10(1 + METER_MAX / 2);

        return Math.round(Math.min(Math.max(fraction, 0), 1) * METER_SWEEP * 10) / 10;
    }

    function renderMeter(value) {
        const meter = state.meter;
        const displayValue = formatNumber(value);
        const angle = meterAngle(value);

        if (meter.renderedValue !== displayValue) {
            elements.meterNumber.textContent = displayValue;
            meter.renderedValue = displayValue;
        }

        if (meter.renderedAngle !== angle) {
            elements.meterRing.style.setProperty("--meter-angle", `${angle}deg`);
            meter.renderedAngle = angle;
        }
    }

    function renderMetric(name, value) {
        const metric = state.metrics[name];
        const displayValue = formatNumber(value);

        if (metric.renderedValue !== displayValue) {
            elements[name].textContent = displayValue;
            metric.renderedValue = displayValue;
        }
    }

    function advanceValue(item, elapsed, duration) {
        if (Math.abs(item.targetValue - item.currentValue) < 0.01) {
            item.currentValue = item.targetValue;
            return false;
        }

        const blend = 1 - Math.exp(-elapsed / duration);

        item.currentValue += (item.targetValue - item.currentValue) * blend;
        return true;
    }

    function render(timestamp) {
        const renderState = state.render;
        const elapsed = renderState.lastFrame ? Math.min(timestamp - renderState.lastFrame, 50) : 16;
        const shouldPaint = renderState.lastPaint === null || timestamp - renderState.lastPaint >= RENDER_INTERVAL;

        renderState.frame = null;
        renderState.lastFrame = timestamp;

        let needsAnotherFrame = advanceValue(state.meter, elapsed, 95);

        Object.values(state.metrics).forEach((metric) => {
            needsAnotherFrame = advanceValue(metric, elapsed, 115) || needsAnotherFrame;
        });

        // Always paint the final frame, so a value can settle exactly on its
        // measurement even when that lands between two 30 FPS paint slots.
        if (shouldPaint || !needsAnotherFrame) {
            renderMeter(state.meter.currentValue);
            Object.keys(state.metrics).forEach((name) => {
                renderMetric(name, state.metrics[name].currentValue);
            });
            renderState.lastPaint = timestamp;
        }

        if (needsAnotherFrame) {
            scheduleRender();
        } else {
            renderState.lastFrame = null;
        }
    }

    function scheduleRender() {
        if (state.render.frame === null) {
            state.render.frame = requestAnimationFrame(render);
        }
    }

    function setMeter(value, phase) {
        state.meter.targetValue = Number.isFinite(value) ? Math.max(0, value) : 0;

        if (typeof phase === "string" && elements.meterPhase.textContent !== phase) {
            elements.meterPhase.textContent = phase;
        }

        scheduleRender();
    }

    function updateMetric(name, value) {
        if (!Number.isFinite(value)) {
            renderMetric(name, value);
            return;
        }

        state.metrics[name].targetValue = value;
        scheduleRender();
    }

    function resetMetrics() {
        Object.keys(state.metrics).forEach((name) => {
            const metric = state.metrics[name];

            metric.currentValue = 0;
            metric.targetValue = 0;
            metric.renderedValue = null;
            elements[name].textContent = "—";
        });

        state.meter.currentValue = 0;
        state.meter.targetValue = 0;
        state.meter.renderedValue = null;
        state.meter.renderedAngle = null;
        renderMeter(0);
    }

    // Lights up the card whose number is currently moving, so the eye knows
    // where to look without having to read the stage copy.
    function setActiveStat(name) {
        statCards.forEach((card, key) => {
            card.classList.toggle("is-active", key === name);
        });
    }

    function setStep(activeStep) {
        ["ping", "download", "upload"].forEach((step, index) => {
            const element = document.getElementById(`step-${step}`);

            if (!element) {
                return;
            }

            element.className = "step";

            if (index < activeStep) {
                element.classList.add("done");
            }

            if (index === activeStep) {
                element.classList.add("active");
            }
        });
    }

    /* --------------------------------------------------------- measurement */

    // Shared by the download and upload stages. Both are "run N transfers at
    // once for up to D milliseconds and watch the aggregate byte counter" —
    // the only difference is how the bytes are produced.
    function createThroughputTracker({ durationMs, onSample }) {
        const started = performance.now();
        const samples = [];

        let totalBytes = 0;
        let lastBytes = 0;
        let lastSampleAt = started;

        function addBytes(count) {
            totalBytes += count;

            const now = performance.now();
            const sinceLastSample = now - lastSampleAt;

            if (sinceLastSample < TEST_CONFIG.sampleIntervalMs) {
                return;
            }

            const instantMbps = ((totalBytes - lastBytes) * 8) / sinceLastSample / 1000;

            lastBytes = totalBytes;
            lastSampleAt = now;

            if (now - started >= TEST_CONFIG.warmupMs) {
                samples.push(instantMbps);
            }

            onSample(instantMbps);
        }

        function isExpired() {
            return performance.now() - started >= durationMs;
        }

        // The headline figure is the median of the post-warmup samples rather
        // than total bytes over total time. Total-over-time drags the result
        // down with the slow-start ramp and with the tail, where individual
        // streams finish at slightly different moments; the median reflects
        // what the link actually sustained.
        function result() {
            const elapsed = performance.now() - started;
            const overall = elapsed > 0 ? (totalBytes * 8) / elapsed / 1000 : 0;

            return samples.length >= 3 ? Math.max(median(samples), overall) : overall;
        }

        return { addBytes, isExpired, result };
    }

    async function measurePing(signal) {
        const readings = [];
        let sent = 0;
        let lost = 0;

        // The first request pays for DNS, the TLS handshake and connection
        // setup. Timing it would measure the handshake, not the round trip.
        for (let index = 0; index < TEST_CONFIG.pingWarmups; index += 1) {
            const warmup = await fetch(`${ENDPOINT}/__down?bytes=0&cache=${Math.random()}`, {
                cache: "no-store",
                signal
            });

            await warmup.arrayBuffer();
        }

        // Browsers give no ICMP access, so "packet loss" here is a fetch that
        // never came back rather than a dropped IP packet. It is still a
        // useful, honestly-labelled proxy: a link that fails a fraction of
        // these tiny round trips will also drop game-state packets.
        for (let index = 0; index < TEST_CONFIG.pingSamples; index += 1) {
            sent += 1;

            try {
                const started = performance.now();
                const response = await fetch(`${ENDPOINT}/__down?bytes=0&cache=${Math.random()}`, {
                    cache: "no-store",
                    signal
                });

                if (!response.ok) {
                    throw new Error("Latency sample failed");
                }

                await response.arrayBuffer();
                readings.push(performance.now() - started);

                updateMetric("ping", median(readings));

                if (readings.length > 1) {
                    updateMetric("jitter", meanDeviation(readings));
                }

                setMeter(Math.max(0, 80 - median(readings)), "Measuring ping");
            } catch (error) {
                if (isAbort(error)) {
                    throw error;
                }

                lost += 1;
            }

            await delay(60, signal);
        }

        if (!readings.length) {
            throw new Error("Latency test unavailable");
        }

        const average = median(readings);
        const jitter = meanDeviation(readings);
        const packetLoss = (lost / sent) * 100;

        updateMetric("ping", average);
        updateMetric("jitter", jitter);

        return { average, jitter, packetLoss };
    }

    async function measureDownload(signal) {
        const tracker = createThroughputTracker({
            durationMs: TEST_CONFIG.downloadDurationMs,
            onSample: (mbps) => {
                updateMetric("download", mbps);
                setMeter(mbps, "Downloading");
            }
        });

        // One controller for the whole stage, so every stream can be cut off
        // the moment the time budget runs out without touching the caller's
        // signal. It is chained to the caller's signal too, so the stop button
        // still works.
        const stageController = new AbortController();
        const stopStage = () => stageController.abort();

        signal.addEventListener("abort", stopStage, { once: true });

        async function runStream() {
            const response = await fetch(
                `${ENDPOINT}/__down?bytes=${TEST_CONFIG.downloadBytesPerStream}&cache=${Math.random()}`,
                { cache: "no-store", signal: stageController.signal }
            );

            if (!response.ok || !response.body) {
                throw new Error("Download test unavailable");
            }

            const reader = response.body.getReader();

            while (true) {
                const { done, value } = await reader.read();

                if (done) {
                    break;
                }

                tracker.addBytes(value.byteLength);

                if (tracker.isExpired()) {
                    // Cancelling closes this stream cleanly, instead of leaving
                    // the rest of a 60 MB body to arrive in the background
                    // after the test has moved on.
                    await reader.cancel().catch(() => { });
                    break;
                }
            }
        }

        try {
            await Promise.all(
                Array.from({ length: TEST_CONFIG.downloadStreams }, () =>
                    runStream().catch((error) => {
                        // One stream failing is survivable — the others carry
                        // the measurement. Only a total failure should surface.
                        if (!isAbort(error)) {
                            console.warn("A download stream failed:", error);
                        }

                        return null;
                    })
                )
            );
        } finally {
            signal.removeEventListener("abort", stopStage);
            stageController.abort();
        }

        if (signal.aborted) {
            throw createAbortError();
        }

        const result = tracker.result();

        if (!Number.isFinite(result) || result <= 0) {
            throw new Error("Download test returned no data");
        }

        updateMetric("download", result);
        return result;
    }

    // Random bytes rather than zeroes: a compressible body would be squeezed
    // in transit and inflate the result.
    async function createUploadPayload(size, signal) {
        const payload = new Uint8Array(size);

        if (!globalThis.crypto || !globalThis.crypto.getRandomValues) {
            return payload;
        }

        for (let offset = 0; offset < payload.length; offset += 65_536) {
            if (signal.aborted) {
                throw createAbortError();
            }

            crypto.getRandomValues(payload.subarray(offset, Math.min(offset + 65_536, payload.length)));

            // Yield periodically so building the body never freezes the UI.
            if (offset > 0 && offset % 1_048_576 === 0) {
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
        }

        return payload;
    }

    // XMLHttpRequest rather than fetch: only XHR reports upload progress.
    // fetch resolves once the response comes back, which tells you when the
    // upload finished but nothing about how it went.
    function uploadStream(payload, signal, tracker) {
        return new Promise((resolve, reject) => {
            const request = new XMLHttpRequest();

            let previousLoaded = 0;
            let settled = false;

            function abortRequest() {
                request.abort();
            }

            function cleanup() {
                signal.removeEventListener("abort", abortRequest);
            }

            function finish() {
                if (settled) {
                    return;
                }

                settled = true;
                cleanup();
                resolve();
            }

            function fail(error) {
                if (settled) {
                    return;
                }

                settled = true;
                cleanup();
                reject(error);
            }

            if (signal.aborted) {
                fail(createAbortError());
                return;
            }

            signal.addEventListener("abort", abortRequest, { once: true });

            request.open("POST", `${ENDPOINT}/__up?cache=${Math.random()}`, true);
            request.timeout = TEST_CONFIG.uploadDurationMs + 6_000;

            request.upload.addEventListener("progress", (event) => {
                if (event.loaded <= previousLoaded) {
                    return;
                }

                tracker.addBytes(event.loaded - previousLoaded);
                previousLoaded = event.loaded;

                if (tracker.isExpired()) {
                    request.abort();
                }
            });

            request.addEventListener("load", finish);
            // An aborted upload is a normal end to a timed stage: whatever
            // bytes made it through are already counted by the tracker.
            request.addEventListener("abort", finish);
            request.addEventListener("timeout", finish);
            request.addEventListener("error", () => fail(new Error("Upload test unavailable")));

            request.send(payload);
        });
    }

    async function measureUpload(signal) {
        const tracker = createThroughputTracker({
            durationMs: TEST_CONFIG.uploadDurationMs,
            onSample: (mbps) => {
                updateMetric("upload", mbps);
                setMeter(mbps, "Uploading");
            }
        });

        const payload = await createUploadPayload(TEST_CONFIG.uploadBytesPerStream, signal);

        await Promise.all(
            Array.from({ length: TEST_CONFIG.uploadStreams }, () =>
                uploadStream(payload, signal, tracker).catch((error) => {
                    if (!isAbort(error)) {
                        console.warn("An upload stream failed:", error);
                    }

                    return null;
                })
            )
        );

        if (signal.aborted) {
            throw createAbortError();
        }

        const result = tracker.result();

        if (!Number.isFinite(result) || result <= 0) {
            throw new Error("Upload test returned no data");
        }

        updateMetric("upload", result);
        return result;
    }

    /* -------------------------------------------------------- verdict copy */

    function getQuality(download, upload, ping, jitter) {
        if (!Number.isFinite(download)) {
            return "—";
        }

        if (download >= 200 && ping <= 40 && jitter <= 8) {
            return "Excellent";
        }

        if (download >= 60 && ping <= 70) {
            return "Great";
        }

        if (download >= 20 && ping <= 120) {
            return "Good";
        }

        if (download >= 5) {
            return "Fair";
        }

        return "Slow";
    }

    function getRecommendation(download, upload, ping, jitter) {
        if (download >= 200 && ping <= 40) {
            return {
                title: "Ready for anything.",
                copy: "4K streaming on several screens, large uploads and low-latency gaming all have plenty of headroom here."
            };
        }

        if (download >= 60) {
            return {
                title: "Comfortable for everyday use.",
                copy: `HD and 4K streaming, video calls and downloads are all fine. ${jitter > 15
                        ? "Jitter is on the high side, so calls may occasionally break up."
                        : "Latency is steady enough for video calls and most gaming."
                    }`
            };
        }

        if (download >= 20) {
            return {
                title: "Good for most things.",
                copy: "HD streaming and video calls work well. A second 4K stream or a big upload may start to compete for the line."
            };
        }

        if (download >= 5) {
            return {
                title: "Workable, with limits.",
                copy: "Fine for browsing, music and standard-definition video. Expect buffering on HD streams and slow large downloads."
            };
        }

        return {
            title: "This connection is struggling.",
            copy: "Try moving closer to the router, switching to the 5 GHz band, or plugging in over Ethernet, then run the test again."
        };
    }

    // Gaming cares about consistency, not throughput: a fast line with a
    // shaky ping still stutters, and 50 Mbps with a rock-steady 15 ms ping
    // is plenty. Packet loss is the harshest input because even a small
    // amount is felt directly as rubber-banding or missed hits.
    function getGamingRating(ping, jitter, packetLoss) {
        const loss = Number.isFinite(packetLoss) ? packetLoss : 0;

        if (ping <= 30 && jitter <= 5 && loss <= 0.5) {
            return {
                tier: "excellent",
                label: "Excellent",
                title: "Great for competitive gaming.",
                copy: "Low, steady ping with next to no dropped requests — this handles fast-paced and competitive online games comfortably."
            };
        }

        if (ping <= 60 && jitter <= 15 && loss <= 1.5) {
            return {
                tier: "good",
                label: "Good",
                title: "Solid for most online games.",
                copy: "Ping and jitter are both in a comfortable range for co-op, shooters and most ranked play, with only occasional variance."
            };
        }

        if (ping <= 100 && jitter <= 30 && loss <= 3) {
            return {
                tier: "fair",
                label: "Playable",
                title: "Playable, with occasional lag.",
                copy: "Turn-based and slower-paced games should feel fine. Fast-twitch competitive play may show occasional lag spikes or rubber-banding."
            };
        }

        return {
            tier: "poor",
            label: "Rough",
            title: "Expect noticeable lag.",
            copy: "Ping, jitter or packet loss are high enough to be felt directly in most online games. A wired connection or a closer access point usually helps most."
        };
    }

    function renderGamingResult(result) {
        if (!readouts.gamingCard) {
            return;
        }

        const rating = getGamingRating(result.ping, result.jitter, result.packetLoss);

        setText(readouts.gamingTitle, rating.title);
        setText(readouts.gamingCopy, rating.copy);
        setText(readouts.gamingPing, `${formatNumber(result.ping)} ms`);
        setText(readouts.gamingJitter, `${formatNumber(result.jitter)} ms`);
        setText(
            readouts.gamingLoss,
            Number.isFinite(result.packetLoss) ? `${formatNumber(result.packetLoss)}%` : "—"
        );

        if (readouts.gamingBadge) {
            readouts.gamingBadge.textContent = rating.label;
            readouts.gamingBadge.dataset.tier = rating.tier;
        }

        readouts.gamingCard.hidden = false;
    }



    const HISTORY_KEY = "signal-speed-history";

    function getHistory() {
        try {
            const raw = localStorage.getItem(HISTORY_KEY);
            const parsed = raw ? JSON.parse(raw) : [];

            return Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            console.warn("Could not read the saved history:", error);
            return [];
        }
    }

    function saveResult(result) {
        try {
            const history = [{ ...result, at: Date.now() }, ...getHistory()].slice(0, 20);

            localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
            renderHistory();
            return true;
        } catch (error) {
            console.warn("Could not save the result:", error);
            return false;
        }
    }

    function renderHistory() {
        const results = getHistory();

        elements.history.replaceChildren();
        elements.exportHistory.disabled = results.length === 0;

        if (!results.length) {
            const emptyMessage = document.createElement("p");

            emptyMessage.className = "empty-history";
            emptyMessage.textContent = "Your completed tests will appear here.";
            elements.history.append(emptyMessage);
            return;
        }

        results.slice(0, 5).forEach((result) => {
            const row = document.createElement("div");
            const date = new Date(result.at);

            row.className = "history-row";
            row.innerHTML = `
                <span class="history-date">${escapeHtml(
                date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
            )} · ${escapeHtml(date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))}</span>
                <span class="history-speed">↓ ${formatNumber(result.download)} <small>Mbps</small></span>
                <span class="history-speed">↑ ${formatNumber(result.upload)} <small>Mbps</small></span>
            `;

            elements.history.append(row);
        });
    }

    async function copyLatestResult() {
        if (!state.lastResult) {
            return;
        }

        const { download, upload, ping, jitter, rating } = state.lastResult;
        const label = elements.copyResult.querySelector("span") || elements.copyResult;
        const text =
            `Signal speed test — ${rating}\n` +
            `Download: ${formatNumber(download)} Mbps\n` +
            `Upload: ${formatNumber(upload)} Mbps\n` +
            `Ping: ${formatNumber(ping)} ms\n` +
            `Jitter: ${formatNumber(jitter)} ms`;

        try {
            if (!navigator.clipboard || !navigator.clipboard.writeText) {
                throw new Error("Clipboard unavailable");
            }

            await navigator.clipboard.writeText(text);

            label.textContent = "Copied";
            setTimeout(() => {
                label.textContent = "Copy latest result";
            }, 1800);
        } catch (error) {
            console.warn("Could not copy the result:", error);
            elements.stage.textContent = "Couldn’t copy the result. Your browser may be blocking clipboard access.";
        }
    }

    function exportSavedHistory() {
        const history = getHistory();

        if (!history.length) {
            return;
        }

        const rows = [
            ["Date", "Download Mbps", "Upload Mbps", "Ping ms", "Jitter ms", "Packet Loss %", "Quality"],
            ...history.map((result) => [
                new Date(result.at).toISOString(),
                formatNumber(result.download),
                formatNumber(result.upload),
                formatNumber(result.ping),
                Number.isFinite(result.jitter) ? formatNumber(result.jitter) : "",
                Number.isFinite(result.packetLoss) ? formatNumber(result.packetLoss) : "",
                result.rating || getQuality(result.download, result.upload, result.ping, result.jitter)
            ])
        ];

        const csv = rows
            .map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(","))
            .join("\n");

        const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
        const link = document.createElement("a");

        link.href = url;
        link.download = "signal-speed-history.csv";
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 0);
    }

    /* --------------------------------------------------- connection readout */

    function qualifier(text, kind) {
        return ` <span class="network-qualifier" data-kind="${kind}">${escapeHtml(text)}</span>`;
    }

    function renderBrowserReport() {
        if (!CONNECTION_API) {
            setText(readouts.browserReport, "Not available");
            setText(
                readouts.browserReportNote,
                "This browser does not implement the Network Information API. Firefox and Safari do not ship it."
            );
            return;
        }

        const effective = CONNECTION_API.effectiveType;
        const tier = effective && EFFECTIVE_TYPES[effective];

        if (!tier) {
            setText(readouts.browserReport, "Not available");
            setText(readouts.browserReportNote, "The browser did not report a quality tier.");
            return;
        }

        setMarkup(readouts.browserReport, escapeHtml(tier) + qualifier(`"${effective}"`, "measured"));

        const hints = [];

        if (Number.isFinite(CONNECTION_API.downlink)) {
            hints.push(`~${CONNECTION_API.downlink} Mbps`);
        }

        if (Number.isFinite(CONNECTION_API.rtt)) {
            hints.push(`~${CONNECTION_API.rtt} ms RTT`);
        }

        setText(
            readouts.browserReportNote,
            'A latency-and-throughput tier that stops at "4g" — not a radio generation. ' +
            (hints.length ? `The browser’s own rounded estimate: ${hints.join(", ")}.` : "")
        );
    }

    // Signal strength: browsers never expose raw dBm/RSSI (that would be a
    // strong fingerprinting signal, same reasoning as the Wi-Fi band note
    // above), so this is a 1-5 bar reading built from whatever the browser
    // *does* expose — Network Information API's effectiveType/downlink/rtt
    // before a test, and the actual measured ping/download once one has run.
    // No location permission is requested for this — it isn't needed for
    // either data source.
    function computeSignalStrength(result) {
        if (result && Number.isFinite(result.download)) {
            const { download, ping, jitter } = result;

            if (download >= 150 && ping <= 30 && jitter <= 6) {
                return { level: 5, tier: "strong", label: "Excellent" };
            }

            if (download >= 60 && ping <= 60) {
                return { level: 4, tier: "good", label: "Strong" };
            }

            if (download >= 20 && ping <= 110) {
                return { level: 3, tier: "fair", label: "Good" };
            }

            if (download >= 5) {
                return { level: 2, tier: "weak", label: "Fair" };
            }

            return { level: 1, tier: "weak", label: "Weak" };
        }

        if (CONNECTION_API && CONNECTION_API.effectiveType) {
            const effective = CONNECTION_API.effectiveType;
            const downlink = CONNECTION_API.downlink;

            if (effective === "4g") {
                return Number.isFinite(downlink) && downlink >= 8
                    ? { level: 5, tier: "strong", label: "Excellent" }
                    : { level: 4, tier: "good", label: "Strong" };
            }

            if (effective === "3g") {
                return { level: 3, tier: "fair", label: "Good" };
            }

            if (effective === "2g") {
                return { level: 2, tier: "weak", label: "Fair" };
            }

            return { level: 1, tier: "weak", label: "Weak" };
        }

        return { level: 0, tier: "", label: "Unknown" };
    }

    function renderSignalStrength(result) {
        const transport = readTransport();
        const strength = computeSignalStrength(result);

        if (readouts.signalBars) {
            readouts.signalBars.dataset.level = String(strength.level);
            readouts.signalBars.dataset.tier = strength.tier;
        }

        if (!strength.level) {
            setText(readouts.signalStrength, "Unknown");
            setText(
                readouts.signalStrengthNote,
                "This browser exposes no signal information yet. Running a test gives an estimate from the measured ping and download speed."
            );
            return;
        }

        const label = `${transport.certain ? transport.label : "Connection"} · ${strength.label}`;

        setMarkup(
            readouts.signalStrength,
            escapeHtml(label) + qualifier(result ? "measured" : "estimated", result ? "measured" : "reported")
        );

        setText(
            readouts.signalStrengthNote,
            result
                ? `Derived from ${formatNumber(result.ping)} ms ping and ${formatNumber(result.download)} Mbps down. Not a radio dBm reading — no browser exposes that.`
                : "A quick estimate from the browser's own connection tier, before any measurement. Run a test for an accurate reading."
        );
    }

    function renderTransport() {
        const transport = readTransport();
        const scope = transport.scope ? ` (${transport.scope})` : "";

        setMarkup(
            elements.connectionType,
            escapeHtml(transport.label + scope) +
            qualifier(transport.certain ? "reported" : "not exposed", transport.certain ? "reported" : "measured")
        );
        setText(readouts.connectionTypeNote, transport.note);
        setText(readouts.link, transport.label);

        return transport;
    }

    // Deliberately requires a finished measurement. Guessing from
    // connection.downlink would be worse than saying nothing, since Chrome
    // caps that value at 10 Mbps and every fast line would look like 3G.
    function renderLinkClass(result) {
        const transport = readTransport();

        if (!result) {
            setText(readouts.linkClass, "Run a test to identify");
            setText(
                readouts.linkClassNote,
                "Needs a measurement. The browser’s own downlink figure is capped at 10 Mbps, so it cannot grade a fast link."
            );
            return;
        }

        const classified = classifyLink(transport.key, result.download, result.ping, result.jitter);

        setMarkup(readouts.linkClass, escapeHtml(classified.title) + qualifier("estimated", "measured"));
        setText(
            readouts.linkClassNote,
            `${classified.note} Derived from ${formatNumber(result.download)} Mbps down, ` +
            `${formatNumber(result.ping)} ms ping, ${formatNumber(result.jitter)} ms jitter.`
        );
    }

    function updateConnection() {
        const online = navigator.onLine;

        elements.status.textContent = online ? "Online" : "Offline";
        elements.statusDot.classList.toggle("offline", !online);

        const transport = renderTransport();

        if (!online) {
            setText(readouts.link, "Disconnected");
        }

        renderBrowserReport();
        renderSignalStrength(state.lastResult || null);

        const pill = elements.status.closest(".connection-pill");

        if (pill) {
            pill.title = online
                ? `${transport.label}${transport.scope ? " — " + transport.scope : ""}. ${transport.note}`
                : "No network connection.";
        }
    }

    /* ------------------------------------------------------------- the run */

    function setTesting(testing) {
        state.testing = testing;
        elements.button.classList.toggle("testing", testing);
        elements.buttonText.textContent = testing ? "Stop test" : "Start speed test";
        elements.meterDial.classList.toggle("is-live", testing);

        if (cockpit) {
            cockpit.classList.toggle("is-live", testing);
        }

        if (!testing) {
            setActiveStat(null);
        }
    }

    function setResultSummary(result, recommendation) {
        state.lastResult = result;
        elements.recommendationTitle.textContent = recommendation.title;
        elements.recommendationCopy.textContent = recommendation.copy;
        elements.copyResult.disabled = false;
        elements.resultSummary.hidden = false;
    }

    async function runTest() {
        if (!navigator.onLine) {
            elements.stage.innerHTML = "<strong>You’re offline.</strong> Reconnect, then try again.";
            return;
        }

        setTesting(true);
        state.controller = new AbortController();
        state.lastResult = null;
        elements.resultSummary.hidden = true;
        elements.copyResult.disabled = true;
        if (readouts.gamingCard) {
            readouts.gamingCard.hidden = true;
        }
        resetMetrics();

        const { signal } = state.controller;

        try {
            setStep(0);
            setActiveStat("ping");
            elements.stage.innerHTML = "Finding the fastest route to <strong>Cloudflare</strong>…";

            const { average: ping, jitter, packetLoss } = await measurePing(signal);

            setStep(1);
            setActiveStat("download");
            elements.stage.innerHTML =
                `Measuring <strong>download</strong> across ${TEST_CONFIG.downloadStreams} connections…`;

            const download = await measureDownload(signal);

            setStep(2);
            setActiveStat("upload");
            elements.stage.innerHTML =
                `Measuring <strong>upload</strong> across ${TEST_CONFIG.uploadStreams} connections…`;

            const upload = await measureUpload(signal);

            const rating = getQuality(download, upload, ping, jitter);
            const result = { ping, download, upload, jitter, packetLoss, rating };
            const saved = saveResult(result);

            setResultSummary(result, getRecommendation(download, upload, ping, jitter));
            renderLinkClass(result);
            renderSignalStrength(result);
            renderGamingResult(result);
            setActiveStat(null);
            setMeter(download, "Test complete");
            setStep(3);

            elements.stage.innerHTML = saved
                ? `<strong>${rating} connection.</strong> Your result is saved on this device.`
                : `<strong>${rating} connection.</strong> The test finished, but the result could not be saved.`;
        } catch (error) {
            if (isAbort(error)) {
                elements.stage.textContent = "Test stopped. Your last completed result is still saved.";
            } else {
                elements.stage.innerHTML =
                    "<strong>We couldn’t complete the test.</strong> Check your connection and try again.";
                console.error("Speed test failed:", error);
            }

            setStep(-1);
            setActiveStat(null);
            setMeter(0, "Ready to test");
        } finally {
            state.controller = null;
            setTesting(false);
        }
    }

    /* -------------------------------------------------------------- wiring */

    elements.button.addEventListener("click", () => {
        if (state.testing && state.controller) {
            state.controller.abort();
            return;
        }

        runTest();
    });

    elements.clearHistory.addEventListener("click", () => {
        try {
            localStorage.removeItem(HISTORY_KEY);
            renderHistory();
        } catch (error) {
            console.warn("Could not clear the history:", error);
        }
    });

    elements.copyResult.addEventListener("click", copyLatestResult);
    elements.exportHistory.addEventListener("click", exportSavedHistory);

    window.addEventListener("online", updateConnection);
    window.addEventListener("offline", updateConnection);

    if (CONNECTION_API && typeof CONNECTION_API.addEventListener === "function") {
        CONNECTION_API.addEventListener("change", updateConnection);
    }

    updateConnection();
    renderLinkClass(null);
    renderHistory();
    renderMeter(0);

    // Pointer-tracked sheen on the console, skipped entirely when the visitor
    // has asked for reduced motion.
    if (cockpit && window.matchMedia("(prefers-reduced-motion: no-preference)").matches) {
        cockpit.addEventListener("pointermove", (event) => {
            const rect = cockpit.getBoundingClientRect();

            cockpit.style.setProperty("--mouse-x", `${event.clientX - rect.left}px`);
            cockpit.style.setProperty("--mouse-y", `${event.clientY - rect.top}px`);
        });
    }

    if (location.protocol === "file:") {
        elements.button.disabled = true;
        elements.buttonText.textContent = "Serve over http first";
        elements.meterPhase.textContent = "Local server required";
        elements.stage.innerHTML =
            "<strong>This page needs to be served over http.</strong> Opening it straight from disk blocks the cross-origin requests the test relies on. Run <code>npm start</code>, or deploy it.";
    }
}

/* ---------------------------------------------------------------- theming */

function initializeTheme() {
    const toggle = document.querySelector("#themeToggle");

    if (!toggle) {
        return;
    }

    function apply(theme) {
        document.documentElement.dataset.theme = theme;
        toggle.setAttribute("aria-checked", theme === "dark" ? "true" : "false");
        toggle.setAttribute("aria-label", theme === "dark" ? "Switch to light mode" : "Switch to dark mode");

        const meta = document.querySelector('meta[name="theme-color"]');

        if (meta) {
            meta.setAttribute("content", theme === "dark" ? "#050914" : "#eaf2ff");
        }

        try {
            localStorage.setItem("signal-theme", theme);
        } catch (error) {
            /* Private browsing can refuse writes. The theme still applies. */
        }
    }

    apply(document.documentElement.dataset.theme === "dark" ? "dark" : "light");

    toggle.addEventListener("click", () => {
        apply(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
    });
}

/* --------------------------------------------------------------- feedback */

// No backend exists to send this to, so it is stored locally only — same
// honesty as the speed-test history. Capped list, no account, no personal
// info collected beyond whatever the person chooses to type.
const FEEDBACK_KEY = "signal-feedback";

function initializeFeedback() {
    const card = document.querySelector(".feedback-card");

    if (!card) {
        return;
    }

    const starButtons = Array.from(card.querySelectorAll(".star-btn"));
    const textarea = card.querySelector("#feedbackText");
    const submitButton = card.querySelector("#feedbackSubmit");
    const thanks = card.querySelector("#feedbackThanks");

    let rating = 0;

    function paintStars(upTo, previewOnly) {
        starButtons.forEach((button) => {
            const value = Number(button.dataset.value);
            const active = value <= upTo;

            button.classList.toggle(previewOnly ? "is-preview" : "is-active", active);

            if (!previewOnly) {
                button.classList.remove("is-preview");
                button.setAttribute("aria-pressed", active ? "true" : "false");
            }
        });
    }

    starButtons.forEach((button) => {
        const value = Number(button.dataset.value);

        button.addEventListener("mouseenter", () => paintStars(value, true));
        button.addEventListener("focus", () => paintStars(value, true));

        button.addEventListener("click", () => {
            rating = value;
            paintStars(rating, false);
        });
    });

    card.querySelector("#feedbackStars").addEventListener("mouseleave", () => paintStars(rating, true));
    card.addEventListener("focusout", (event) => {
        if (!card.contains(event.relatedTarget)) {
            paintStars(rating, true);
        }
    });

    function saveFeedback(entry) {
        try {
            const raw = localStorage.getItem(FEEDBACK_KEY);
            const existing = raw ? JSON.parse(raw) : [];
            const history = Array.isArray(existing) ? existing : [];

            history.unshift(entry);
            localStorage.setItem(FEEDBACK_KEY, JSON.stringify(history.slice(0, 20)));
            return true;
        } catch (error) {
            console.warn("Could not save feedback:", error);
            return false;
        }
    }

    submitButton.addEventListener("click", () => {
        const text = textarea.value.trim();

        if (!rating && !text) {
            textarea.focus();
            return;
        }

        saveFeedback({ rating, text, at: Date.now() });

        submitButton.disabled = true;
        thanks.hidden = false;

        setTimeout(() => {
            rating = 0;
            textarea.value = "";
            paintStars(0, false);
            submitButton.disabled = false;
            thanks.hidden = true;
        }, 3200);
    });
}

function start() {
    initializeTheme();
    initializeSpeedTest();
    initializeFeedback();
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
} else {
    start();
}
