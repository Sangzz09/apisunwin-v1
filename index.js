import express from "express";
import axios from "axios";
import cors from "cors";

const app = express();
app.use(cors());
const PORT = process.env.PORT || 3000;
const SOURCE = "https://meuni-basally-xzavier.ngrok-free.dev/api/history";

let history = [];
let algoWeights = {};
const MAX_HISTORY = 500;

// ================= UTILS =================
function sumDice(d) {
  return d.reduce((a, b) => a + b, 0);
}
function taiXiu(t) {
  return t >= 11 ? "Tài" : "Xỉu";
}

// ================= THUẬT TOÁN (giữ nguyên như bản nâng cấp) =================
// ... (các hàm markov1, markov2, markov3, trend, streak, frequency, momentum, hidden, monteCarloReal, advancedPattern, cycleAnalysis, totalAverage, updateWeights, aiPredict) ...
// LƯU Ý: Các hàm này không thay đổi, nhưng totalAverage cần điều chỉnh để dùng Tong hoặc xúc xắc từ historyRaw

// Ví dụ sửa totalAverage:
function totalAverage(historyRaw) {
  if (historyRaw.length < 10) return null;
  let totals = historyRaw.map(v => {
    // Nếu có trường Tong thì dùng, không thì tính từ xúc xắc
    if (v.Tong !== undefined) return v.Tong;
    let d = [v.Xuc_xac_1 || 1, v.Xuc_xac_2 || 1, v.Xuc_xac_3 || 1];
    return sumDice(d);
  });
  let avg = totals.slice(-10).reduce((a, b) => a + b, 0) / 10;
  return avg >= 11 ? "Tài" : "Xỉu";
}

// ================= FETCH DỮ LIỆU (sửa lại) =================
async function load() {
  try {
    let r = await axios.get(SOURCE);
    // Kiểm tra nếu dữ liệu có trường history là mảng
    if (r.data && Array.isArray(r.data.history)) {
      history = r.data.history.slice(-MAX_HISTORY);
      console.log(`Đã cập nhật ${history.length} phiên`);
    } else {
      console.log("Dữ liệu không có history mảng:", r.data);
    }
  } catch (e) {
    console.log("Fetch error:", e.message);
  }
}
load();
setInterval(load, 5000);

// ================= API =================
app.get("/api", (req, res) => {
  if (history.length === 0) {
    return res.json({ error: "no_data" });
  }
  let last = history[history.length - 1];
  
  // Lấy dice từ last (theo cấu trúc mới)
  let dice = [
    last.Xuc_xac_1 || 1,
    last.Xuc_xac_2 || 1,
    last.Xuc_xac_3 || 1
  ];
  let total = last.Tong !== undefined ? last.Tong : sumDice(dice);
  let result = last.Ket_qua || taiXiu(total);
  
  // Tạo mảng kết quả lịch sử (Tài/Xỉu)
  let arr = history.map(v => {
    if (v.Ket_qua) return v.Ket_qua;
    let d = [v.Xuc_xac_1 || 1, v.Xuc_xac_2 || 1, v.Xuc_xac_3 || 1];
    return taiXiu(sumDice(d));
  });
  
  // Gọi AI dự đoán (cần truyền cả history gốc cho totalAverage)
  let ai = aiPredict(arr, history);
  
  res.json({
    phien: last.Phien || last.session || last.phien || history.length,
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
  console.log(`SICBO ULTRA AI RUNNING at http://localhost:${PORT}`);
});
