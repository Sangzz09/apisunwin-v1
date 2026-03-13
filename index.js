import express from "express";
import axios from "axios";
import cors from "cors";

const app = express();
app.use(cors());
const PORT = process.env.PORT || 3000;
const SOURCE = "https://meuni-basally-xzavier.ngrok-free.dev/api/history";

let history = [];
let algoWeights = {}; // trọng số động cho từng thuật toán
const MAX_HISTORY = 500;

// ================= UTILS =================
function sumDice(d) {
  return d.reduce((a, b) => a + b, 0);
}
function taiXiu(t) {
  return t >= 11 ? "Tài" : "Xỉu";
}

// ================= THUẬT TOÁN CƠ BẢN (giữ lại và nâng cấp) =================
function markov1(data) {
  if (data.length < 2) return "Tài";
  let map = { Tài: { Tài: 0, Xỉu: 0 }, Xỉu: { Tài: 0, Xỉu: 0 } };
  for (let i = 0; i < data.length - 1; i++) {
    let a = data[i];
    let b = data[i + 1];
    map[a][b]++;
  }
  let last = data[data.length - 1];
  return map[last].Tài > map[last].Xỉu ? "Tài" : "Xỉu";
}

// Markov bậc 2 (dựa trên 2 phiên trước)
function markov2(data) {
  if (data.length < 3) return "Tài";
  let map = {};
  for (let i = 0; i < data.length - 2; i++) {
    let key = data[i] + "," + data[i + 1];
    let next = data[i + 2];
    if (!map[key]) map[key] = { Tài: 0, Xỉu: 0 };
    map[key][next]++;
  }
  let lastKey = data[data.length - 2] + "," + data[data.length - 1];
  if (!map[lastKey]) return "Tài";
  let pred = map[lastKey];
  return pred.Tài > pred.Xỉu ? "Tài" : "Xỉu";
}

// Markov bậc 3
function markov3(data) {
  if (data.length < 4) return "Tài";
  let map = {};
  for (let i = 0; i < data.length - 3; i++) {
    let key = data[i] + "," + data[i + 1] + "," + data[i + 2];
    let next = data[i + 3];
    if (!map[key]) map[key] = { Tài: 0, Xỉu: 0 };
    map[key][next]++;
  }
  let lastKey = data[data.length - 3] + "," + data[data.length - 2] + "," + data[data.length - 1];
  if (!map[lastKey]) return "Tài";
  let pred = map[lastKey];
  return pred.Tài > pred.Xỉu ? "Tài" : "Xỉu";
}

function trend(data) {
  let w = data.slice(-10);
  let t = w.filter(x => x == "Tài").length;
  let x = w.filter(x => x == "Xỉu").length;
  return t >= x ? "Tài" : "Xỉu";
}

function streak(data) {
  let last = data[data.length - 1];
  let c = 0;
  for (let i = data.length - 1; i >= 0; i--) {
    if (data[i] == last) c++;
    else break;
  }
  if (c >= 3) return last == "Tài" ? "Xỉu" : "Tài";
  return last;
}

function frequency(data) {
  let t = data.filter(x => x == "Tài").length;
  let x = data.filter(x => x == "Xỉu").length;
  return t > x ? "Xỉu" : "Tài";
}

function momentum(data) {
  let l = data.slice(-6);
  let s = 0;
  l.forEach((v, i) => {
    if (v == "Tài") s += i + 1;
    else s -= i + 1;
  });
  return s > 0 ? "Tài" : "Xỉu";
}

function hidden(data) {
  let l = data.slice(-3);
  let t = l.filter(x => x == "Tài").length;
  return t >= 2 ? "Tài" : "Xỉu";
}

// Monte Carlo dựa trên phân phối thực tế của xúc xắc (từ lịch sử)
function monteCarloReal(historyData) {
  if (historyData.length < 50) return Math.random() > 0.5 ? "Tài" : "Xỉu";
  // Tính xác suất Tài từ dữ liệu gần nhất
  let recent = historyData.slice(-100);
  let tCount = recent.filter(x => x == "Tài").length;
  let probT = tCount / recent.length;
  let rand = Math.random();
  return rand < probT ? "Tài" : "Xỉu";
}

// Phát hiện pattern mở rộng
function advancedPattern(data) {
  let last4 = data.slice(-4).join("");
  let patterns = {
    "TàiTàiXỉuXỉu": "Tài",
    "XỉuXỉuTàiTài": "Xỉu",
    "TàiXỉuTàiXỉu": "Tài",
    "XỉuTàiXỉuTài": "Xỉu",
    "TàiTàiTàiXỉu": "Xỉu",
    "XỉuXỉuXỉuTài": "Tài",
    "TàiXỉuXỉuTài": "Xỉu",
    "XỉuTàiTàiXỉu": "Tài",
  };
  return patterns[last4] || null;
}

// Phân tích chu kỳ (cycle) – tìm chu kỳ lặp lại phổ biến
function cycleAnalysis(data) {
  if (data.length < 20) return null;
  // Thử với chu kỳ 4,5,6
  for (let cycle of [4, 5, 6]) {
    let lastCycle = data.slice(-cycle);
    let matches = 0;
    for (let i = data.length - cycle * 2; i >= 0; i -= cycle) {
      let prev = data.slice(i, i + cycle);
      if (prev.join("") === lastCycle.join("")) matches++;
    }
    if (matches >= 2) return lastCycle[0]; // dự đoán theo chu kỳ
  }
  return null;
}

// Dựa trên trung bình tổng điểm (moving average)
function totalAverage(historyRaw) {
  if (historyRaw.length < 10) return null;
  let totals = historyRaw.map(v => {
    let d = v.dice || v.xucxac || [1, 1, 1];
    return sumDice(d);
  });
  let avg = totals.slice(-10).reduce((a, b) => a + b, 0) / 10;
  return avg >= 11 ? "Tài" : "Xỉu";
}

// ================= TÍNH TRỌNG SỐ ĐỘNG =================
function updateWeights(historyData) {
  if (historyData.length < 50) return;
  let algos = {
    markov1, markov2, markov3, trend, streak, frequency, momentum, hidden,
    monteCarloReal, advancedPattern, cycleAnalysis, totalAverage
  };
  let recent = historyData.slice(-100); // dùng 100 phiên gần nhất để đánh giá
  let results = historyData.map(v => {
    let d = v.dice || v.xucxac || [1, 1, 1];
    return taiXiu(sumDice(d));
  });

  for (let [name, func] of Object.entries(algos)) {
    let correct = 0;
    for (let i = 50; i < recent.length; i++) { // bắt đầu từ phiên thứ 50 để có đủ dữ liệu
      let subData = results.slice(0, historyData.indexOf(recent[i])); // lịch sử trước phiên đó
      if (subData.length < 10) continue;
      let pred;
      if (name === 'totalAverage') {
        pred = func(historyData.slice(0, historyData.indexOf(recent[i])));
      } else if (name === 'monteCarloReal') {
        pred = func(subData);
      } else if (name === 'cycleAnalysis') {
        pred = func(subData);
      } else {
        pred = func(subData);
      }
      if (pred === results[historyData.indexOf(recent[i])]) correct++;
    }
    let accuracy = correct / (recent.length - 50) || 0.5;
    algoWeights[name] = accuracy;
  }
}

// ================= AI DỰ ĐOÁN NÂNG CẤP =================
function aiPredict(results, historyRaw) {
  // Cập nhật trọng số mỗi lần dự đoán (có thể cache lại để đỡ nặng)
  if (Object.keys(algoWeights).length === 0 && historyRaw.length > 100) {
    updateWeights(historyRaw);
  }

  let votes = [];
  let algos = [
    { name: 'markov1', func: markov1 },
    { name: 'markov2', func: markov2 },
    { name: 'markov3', func: markov3 },
    { name: 'trend', func: trend },
    { name: 'streak', func: streak },
    { name: 'frequency', func: frequency },
    { name: 'momentum', func: momentum },
    { name: 'hidden', func: hidden },
    { name: 'monteCarloReal', func: (d) => monteCarloReal(d) },
    { name: 'advancedPattern', func: (d) => advancedPattern(d) },
    { name: 'cycleAnalysis', func: (d) => cycleAnalysis(d) },
    { name: 'totalAverage', func: (d) => totalAverage(historyRaw) } // cần history gốc
  ];

  let weightedVotes = { Tài: 0, Xỉu: 0 };
  let patternDetected = "normal";

  for (let algo of algos) {
    let pred = algo.func(results);
    if (!pred) continue; // bỏ qua nếu không dự đoán được
    let weight = algoWeights[algo.name] || 0.5; // trọng số mặc định 0.5
    weightedVotes[pred] += weight;

    // nhận diện pattern
    if (algo.name === 'advancedPattern' && pred) patternDetected = "pattern_detected";
  }

  let predict = weightedVotes.Tài > weightedVotes.Xỉu ? "Tài" : "Xỉu";
  let totalWeight = weightedVotes.Tài + weightedVotes.Xỉu;
  let conf = Math.round((Math.max(weightedVotes.Tài, weightedVotes.Xỉu) / totalWeight) * 100);

  return {
    predict,
    conf,
    pattern: patternDetected
  };
}

// ================= FETCH DỮ LIỆU =================
async function load() {
  try {
    let r = await axios.get(SOURCE);
    if (Array.isArray(r.data)) {
      history = r.data.slice(-MAX_HISTORY);
    }
  } catch (e) {
    console.log("Fetch error:", e.message);
  }
}
load();
setInterval(load, 5000);

// ================= API =================
app.get("/api", (req, res) => {
  if (history.length == 0) {
    return res.json({ error: "no_data" });
  }
  let last = history[history.length - 1];
  let dice = last.dice || last.xucxac || [1, 1, 1];
  let total = sumDice(dice);
  let result = taiXiu(total);
  let arr = history.map(v => {
    let d = v.dice || v.xucxac || [1, 1, 1];
    return taiXiu(sumDice(d));
  });
  let ai = aiPredict(arr, history);

  res.json({
    phien: last.session || last.phien || history.length,
    ket_qua: dice,
    tong: total,
    result: result,
    du_doan: ai.predict,
    do_tin_cay: ai.conf + "%",
    pattern: ai.pattern,
    id: "@sewdangcap"
  });
});

app.listen(PORT, () => {
  console.log("SICBO ULTRA AI RUNNING with enhanced algorithms");
});
