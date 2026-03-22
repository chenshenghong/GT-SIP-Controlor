# SIP 廣播終端 - REST API 介面規格與測試環境配置

**文件版本**：1.0
**資料來源**：Postman API 測試集合 (SIP終端測試-組播版) 與環境變數設定檔。
**主要用途**：作為前端 (Vue 3 / Axios) 呼叫設備 HTTP Web Server 的標準 API 參考字典。提供精確的 Endpoint、Payload 結構與底層硬體通訊的防呆細節。

## 一、 全域環境配置 (Environment Variables)
- **設備預設 IP (`device_ip`)**: `192.168.1.200`
- **Base URL (`base_url`)**: `http://192.168.1.200`
- **預設帳號 (`username`)**: `admin`
- **預設密碼 (`password`)**: `123456`
- **授權 Token (`token`)**: 登入成功後取得的 JWT 字串。

## 二、 API 請求通用規範與防呆鐵律 (Global Rules)
1. **HTTP Headers 規定**：
   - 請求資料格式：`Content-Type: application/json`
   - 接收資料格式：`Accept: application/json; charset=UTF-8`
   - 授權驗證：除 `/auth/login` 外，所有請求必須於 Header 帶入 `Authorization: Bearer <Token>`。
2. **🚨 強制髒資料過濾 (Dirty JSON Interceptor)**：
   - **問題描述**：根據 Postman 測試腳本，設備底層 (C/C++) 回傳的 HTTP Response Body 結尾，經常夾帶非法的 ASCII 控制字元 (`\u0000-\u001F`, `\u007F-\u009F`)，這會導致原生 `JSON.parse` 崩潰白屏。
   - **實作規定**：前端 Axios 的 `transformResponse` 必須完全實作以下清洗邏輯：
     ```javascript
     const cleanText = responseText.replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim();
     const jsonData = JSON.parse(cleanText);
     ```

---

## 三、 API 端點詳細清單 (API Endpoints)

### [模組 1] 系統認證 (Auth)
*   **1.1 登入並取得 Token**
    *   `POST /auth/login`
    *   **Payload:**
        ```json
        {
          "username": "admin",
          "password": "123456"
        }
        ```
    *   **行為:** 成功回傳包含 `token` 的 JSON，需存入 LocalStorage 供後續請求使用。
*   **1.2 驗證 Token**
    *   `GET /auth/verify`
    *   **用途:** 前端路由守衛驗證或背景 Ping 探測。回傳應包含 `"status": "success"`。

### [模組 2] 狀態監控與設備資訊 (Status & Info)
*   **2.1 獲取設備綜合狀態**
    *   `GET /get/device/status`
    *   **回傳特徵:** 包含 `device_info`, `sip_status`, `network_info` 三個核心物件。
    *   **UX 要求:** 需綁定短輪詢 (Polling，如每 3 秒一次) 更新儀表板。
*   **2.2 獲取系統版本信息**
    *   `GET /system/info`
*   **2.3 重啟設備 ⚠️**
    *   `POST /system/restart`
    *   **Payload:**
        ```json
        {
          "confirm": true
        }
        ```
    *   **UX 要求:** 觸發後設備必定斷線。前端需即刻顯示 45 秒全螢幕倒數遮罩，結束後重新整理頁面。

### [模組 3] 音頻與音量控制 (Audio)
*   **3.1 獲取音量設置**
    *   `GET /get/device/volume`
*   **3.2 設置音量**
    *   `POST /set/device/volume`
    *   **Payload:**
        ```json
        {
          "broadcast_volume": 7,
          "microphone_volume": 8
        }
        ```

### [模組 4] SIP 核心通訊與組播 (SIP & Multicast)
*   **4.1 獲取全部 SIP 配置**
    *   `GET /get/sip/config`
*   **4.2 設置主 SIP 線路 (Primary)**
    *   `POST /set/sip/primary`
    *   **Payload:**
        ```json
        {
          "server_address": "192.168.1.11",
          "server_port": 8899,
          "user_id": "1027",
          "password": "123456",
          "auto_answer": true,
          "register_timeout": 3600,
          "transport_protocol": "TCP"
        }
        ```
*   **4.3 設置組播接收 (Multicast)**
    *   `POST /set/sip/multicast`
    *   **Payload:**
        ```json
        {
          "multicast_address": "239.168.12.1",
          "multicast_port": 2000,
          "enabled": true,
          "audio_codec": "G.722"
        }
        ```
*   **4.4 設置 SIP 進階參數**
    *   `POST /set/sip/parameters`
    *   **Payload:**
        ```json
        {
          "local_port": 8899,
          "rtp_start_port": 10000,
          "rtp_end_port": 20000,
          "rtp_timeout": 30,
          "echo_cancellation": true
        }
        ```
*   **4.5 設置音頻編碼 (Codecs)**
    *   `POST /set/sip/codecs`
    *   **Payload:**
        ```json
        {
          "g722": false,
          "opus": true,
          "g711_ulaw": false,
          "g711_alaw": false
        }
        ```

### [模組 5] 通話控制 (Call Control)
*   **5.1 獲取通話狀態**
    *   `GET /get/call/status`
    *   **UX 要求:** 需與設備狀態一併放入短輪詢 (Polling) 機制中。
*   **5.2 軟體通話控制**
    *   `POST /call/control`
    *   **Payload:**
        ```json
        {
          "action": "dial", 
          "number": "1001"
        }
        ```
    *   **說明:** `action` 參數支援 `dial` (撥號), `answer` (接聽), `hangup` (掛斷)。

### [模組 6] 網路配置 (Network)
*   **6.1 獲取網路設置**
    *   `GET /get/network/config`
*   **6.2 設置網路配置 ⚠️**
    *   `POST /set/network/config`
    *   **Payload:**
        ```json
        {
          "network_mode": "static",
          "ip_address": "192.168.1.200",
          "subnet_mask": "255.255.255.0",
          "gateway": "192.168.1.1",
          "dns": "8.8.8.8"
        }
        ```
    *   **UX 要求:** 成功修改 IP 後，當前連線會中斷。前端需觸發倒數遮罩，並背景不斷 Ping 新目標 IP，連通後執行跳轉 (`window.location.href`)。