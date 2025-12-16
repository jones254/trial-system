const TD_API_KEY = "d1babeb679ab40b3874b0541d46f6059"; // WARNING: Exposed Key
const BASE_URL = "https://api.twelvedata.com";

const generateBtn = document.getElementById('generateBtn');
const loadingDiv = document.getElementById('loading');
const errorDiv = document.getElementById('error');
const resultsDiv = document.getElementById('results');
const analysisList = document.getElementById('analysisList');

generateBtn.addEventListener('click', async () => {
    const symbol = document.getElementById('symbol').value.toUpperCase().trim();
    const bias = document.querySelector('input[name="bias"]:checked').value;
    const confidence = parseInt(document.getElementById('confidence').value);
    const avgRsiInput = document.getElementById('avgRsi').value;
    const avgRsi = avgRsiInput ? parseFloat(avgRsiInput) : null;

    if (!symbol) {
        showError("Please enter a currency pair symbol.");
        return;
    }

    resetUI();
    loadingDiv.classList.remove('hidden');

    try {
        // 1. Fetch Data concurrently (Price, 15m, 30m, 1h)
        // We ask for 20 candles to find recent highs/lows
        const [priceData, m15Data, m30Data, h1Data] = await Promise.all([
            fetchData(`${BASE_URL}/price?symbol=${symbol}&apikey=${TD_API_KEY}`),
            fetchData(`${BASE_URL}/time_series?symbol=${symbol}&interval=15min&outputsize=20&apikey=${TD_API_KEY}`),
            fetchData(`${BASE_URL}/time_series?symbol=${symbol}&interval=30min&outputsize=20&apikey=${TD_API_KEY}`),
            fetchData(`${BASE_URL}/time_series?symbol=${symbol}&interval=1h&outputsize=20&apikey=${TD_API_KEY}`)
        ]);

        // Validate API responses
        if (priceData.code || m15Data.code || m30Data.code || h1Data.code) {
            throw new Error("API Error: " + (priceData.message || m15Data.message || "Rate limit or invalid symbol detected."));
        }

        // 2. Process Data & Generate Plan
        const currentPrice = parseFloat(priceData.price);
        const plan = generateTradePlan(symbol, currentPrice, bias, confidence, avgRsi, m15Data.values, m30Data.values, h1Data.values);

        // 3. Display Results
        displayResults(plan);

    } catch (error) {
        showError(error.message);
    } finally {
        loadingDiv.classList.add('hidden');
    }
});


async function fetchData(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    return await response.json();
}

function showError(msg) {
    errorDiv.innerText = msg;
    errorDiv.classList.remove('hidden');
    resultsDiv.classList.add('hidden');
}

function resetUI() {
    errorDiv.classList.add('hidden');
    resultsDiv.classList.add('hidden');
    analysisList.innerHTML = '';
}

// Helper to determine pip multiplier (e.g., 0.01 for JPY pairs, 0.0001 for others)
function getPipMultiplier(symbol) {
    return symbol.includes('JPY') ? 0.01 : 0.0001;
}

// Helper to find lowest low and highest high across multiple timeframes datasets
function findExtremes(datasets) {
    let lowestLow = Infinity;
    let highestHigh = -Infinity;

    datasets.forEach(data => {
        data.forEach(candle => {
            const low = parseFloat(candle.low);
            const high = parseFloat(candle.high);
            if (low < lowestLow) lowestLow = low;
            if (high > highestHigh) highestHigh = high;
        });
    });

    return { lowestLow, highestHigh };
}

// --- CORE LOGIC: THE HEURISTIC MODEL ---
function generateTradePlan(symbol, currentPrice, bias, confidence, avgRsi, m15Data, m30Data, h1Data) {
    const pipMult = getPipMultiplier(symbol);
    const analysisNotes = [];
    
    // 1. Analyze Market Structure (Support/Resistance proxies)
    // Find extremes over the recent combined data to find significant levels
    const extremes = findExtremes([m15Data, m30Data, h1Data]);
    
    let entryPrice, stopLoss, takeProfit, orderType;
    let slPips, tpPips;

    // Base SL Buffer (to avoid getting stopped out exactly on the wick)
    // Higher confidence = tighter buffer tolerated. Lower confidence = wider buffer.
    const baseBufferPips = 15 - confidence; // e.g., Conf 10 = 5 pips buffer, Conf 1 = 14 pips buffer
    const bufferAmount = baseBufferPips * pipMult;

    // 2. Determine Order Type based on RSI and Price Action relative to extremes
    // This is a simplified mean-reversion vs momentum logic.
    orderType = "Market Execution"; // Default

    if (bias === 'BUY') {
        // If price is near recent highs, don't buy at market, wait for pullback (Limit)
        // Or if RSI is already high (e.g., > 60), wait for pullback.
        if ((currentPrice > extremes.highestHigh * 0.998) || (avgRsi !== null && avgRsi > 60)) {
            orderType = "Buy Limit";
            analysisNotes.push(`Price is near recent highs or RSI is elevated (${avgRsi}). Suggesting a Limit order for a better entry price.`);
            // Set entry slightly above the recent significant low + buffer
            entryPrice = extremes.lowestLow + (bufferAmount * 0.5); 
        } else {
             analysisNotes.push("Market conditions suggest direct entry based on your bias.");
             entryPrice = currentPrice;
        }

        // Stop Loss: Below the recent lowest low across timeframes
        stopLoss = extremes.lowestLow - bufferAmount;
        analysisNotes.push(`SL placed below the recent lowest low found across 15m/30m/1h timeframes (+ ${baseBufferPips} pip buffer).`);

    } else { // SELL BIAS
        // If price is near recent lows, don't sell at market, wait for bounce (Limit)
        // Or if RSI is already low (e.g., < 40), wait for bounce.
        if ((currentPrice < extremes.lowestLow * 1.002) || (avgRsi !== null && avgRsi < 40)) {
            orderType = "Sell Limit";
            analysisNotes.push(`Price is near recent lows or RSI is depressed (${avgRsi}). Suggesting a Limit order for a better entry price.`);
             // Set entry slightly below the recent significant high - buffer
            entryPrice = extremes.highestHigh - (bufferAmount * 0.5);
        } else {
            analysisNotes.push("Market conditions suggest direct entry based on your bias.");
            entryPrice = currentPrice;
        }

        // Stop Loss: Above the recent highest high
        stopLoss = extremes.highestHigh + bufferAmount;
        analysisNotes.push(`SL placed above the recent highest high found across 15m/30m/1h timeframes (+ ${baseBufferPips} pip buffer).`);
    }

    // Ensure Entry is logical relative to current price for limit orders
    if(orderType === 'Buy Limit' && entryPrice >= currentPrice) entryPrice = currentPrice - (5 * pipMult);
    if(orderType === 'Sell Limit' && entryPrice <= currentPrice) entryPrice = currentPrice + (5 * pipMult);


    // 3. Calculate Pips Distance for SL
    slPips = Math.abs(entryPrice - stopLoss) / pipMult;

    // Sanity check for SL (if data is weird and SL ends up being 0 or massive)
    if (slPips < 5) {
        slPips = 15; // Minimum safety fallback
        stopLoss = bias === 'BUY' ? entryPrice - (15 * pipMult) : entryPrice + (15 * pipMult);
        analysisNotes.push("Calculated SL was too tight based on data. Adjusted to a minimum 15 pip safety net.");
    }

    // 4. Determine Take Profit based on Risk:Reward and Confidence
    // Higher confidence = aim for higher R:R ratio.
    // Conf 1-4: R:R 1:1 to 1:1.4
    // Conf 5-7: R:R 1:1.5 to 1:2
    // Conf 8-10: R:R 1:2 to 1:3
    let riskRewardRatio = 1.0 + (confidence / 5); // Simple formula to scale R:R

    tpPips = slPips * riskRewardRatio;

    if (bias === 'BUY') {
        takeProfit = entryPrice + (tpPips * pipMult);
    } else {
        takeProfit = entryPrice - (tpPips * pipMult);
    }
    
    analysisNotes.push(`TP calculated based on a Risk:Reward ratio of 1:${riskRewardRatio.toFixed(1)}, derived from your confidence score of ${confidence}.`);

    // Final Formatting
    return {
        symbol: symbol,
        currentPrice: currentPrice.toFixed(symbol.includes('JPY') ? 3 : 5),
        orderType: orderType,
        entry: entryPrice.toFixed(symbol.includes('JPY') ? 3 : 5),
        sl: stopLoss.toFixed(symbol.includes('JPY') ? 3 : 5),
        tp: takeProfit.toFixed(symbol.includes('JPY') ? 3 : 5),
        slPips: Math.round(slPips),
        tpPips: Math.round(tpPips),
        rr: `1:${riskRewardRatio.toFixed(1)}`,
        notes: analysisNotes
    };
}

function displayResults(plan) {
    document.getElementById('resSymbol').innerText = plan.symbol;
    document.getElementById('resCurrentPrice').innerText = plan.currentPrice;
    document.getElementById('resOrderType').innerText = plan.orderType;
    document.getElementById('resEntry').innerText = plan.entry;
    document.getElementById('resSL').innerText = plan.sl;
    document.getElementById('resSLPips').innerText = `(${plan.slPips} pips)`;
    document.getElementById('resTP').innerText = plan.tp;
    document.getElementById('resTPPips').innerText = `(${plan.tpPips} pips)`;
    document.getElementById('resRR').innerText = plan.rr;

    plan.notes.forEach(note => {
        const li = document.createElement('li');
        li.innerText = note;
        analysisList.appendChild(li);
    });

    resultsDiv.classList.remove('hidden');
}
