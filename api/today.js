const { todayPayload } = require("../server");

module.exports = async (req, res) => {
    try {
        res.setHeader("Cache-Control", "no-store");
        res.status(200).json(await todayPayload());
    } catch (error) {
        res.status(500).json({ error: error.message || "목록을 받지 못했습니다" });
    }
};
