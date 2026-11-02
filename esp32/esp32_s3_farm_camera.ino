/*
 * 养殖监测终端固件
 *
 * 硬件平台：ESP32-S3（N16R8）+ DHT11 + 光敏 + 土壤 + 火焰 + OLED + OV3660 摄像头
 *
 * 主要功能：
 *   1. 周期读取传感器数据，并在 OLED 上分页显示
 *   2. 通过 HTTP POST 上报环境数据到服务端 /api/data
 *   3. 定时上传摄像头快照到 /api/camera，供外网查看
 *   4. 在本机 81 端口提供 MJPEG 视频流，局域网浏览器可直接播放
 *
 * 编译要求：Arduino IDE 中选择开发板 "ESP32S3 Dev Module"，PSRAM 选择 "OPI PSRAM"。
 *
 * 依赖库：DHT sensor library、Adafruit Unified Sensor、Adafruit SSD1306、
 *         Adafruit GFX Library、esp32-camera
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <DHT.h>
#include "esp_camera.h"
#include <mbedtls/base64.h>

// ==================== WiFi 与服务器 ====================
const char* ssid      = "123";
const char* password  = "20080314";
const char* serverUrl = "http://106.55.251.138:3000/api/data";
const char* camUrl    = "http://106.55.251.138:3000/api/camera/esp32-01";
const char* DEVICE_ID = "esp32-01";
const char* DEVICE_NAME = "1号鸡舍";

// ==================== 传感器引脚（避开摄像头占用的 4,5,6,7,8,9,10,11,12,13,15,16,17,18） ====================
#define PIN_DHT     47   // DHT11 数据（原14读不到，改到47）
#define DHTTYPE     DHT11
#define PIN_SOIL    1    // 土壤 AO  ADC1_CH0
// JW01 二氧化碳（UART1，A/B 为 TTL 串口，9600 8N1）
#define PIN_CO2_RX  2    // JW01 B(模块TX) → ESP32 RX
#define PIN_CO2_TX  14   // JW01 A(模块RX) → ESP32 TX（可不接）
// SC7A20H 进食检测（UART2）
#define PIN_FEED_RX 38   // SC7A20H TX → ESP32 RX
#define PIN_FEED_TX 39   // SC7A20H RX → ESP32 TX（可不接）
#define PIN_LIGHT   3    // 光敏 AO  ADC1_CH2
#define PIN_FLAME   21   // 火焰 DO
#define OLED_SDA    41   // OLED SDA
#define OLED_SCL    42   // OLED SCL

// ==================== 摄像头引脚（板载固定，ESP32-S3-EYE 标准） ====================
#define CAM_XCLK  15
#define CAM_SIOD  4
#define CAM_SIOC  5
#define CAM_D7    16
#define CAM_D6    17
#define CAM_D5    18
#define CAM_D4    12
#define CAM_D3    10
#define CAM_D2    8
#define CAM_D1    9
#define CAM_D0    11
#define CAM_VSYNC 6
#define CAM_HREF  7
#define CAM_PCLK  13
#define CAM_PWDN  -1
#define CAM_RESET -1

// ==================== 阈值与标定 ====================
#define TEMP_MAX      35.0f
#define TEMP_MIN      10.0f
#define FLAME_ACTIVE  LOW
#define SOIL_DRY     3200
#define SOIL_WET     1400

// JW01 模拟 CO2 标定（模块到了按实际输出改这里）
#define CO2_CAL_V0    0.4f    // 低浓度对应电压
#define CO2_CAL_PPM0  400.0f  // 低浓度值
#define CO2_CAL_V1    2.0f    // 高浓度对应电压
#define CO2_CAL_PPM1  2000.0f // 高浓度值

#define REPORT_INTERVAL 3000    // 环境数据每 3 秒上报一次
#define READ_INTERVAL   3000    // 传感器每 3 秒采集一次
#define PAGE_INTERVAL   3000
#define CAM_INTERVAL    1000    // 摄像头保持 1 秒一帧

DHT dht(PIN_DHT, DHTTYPE);
Adafruit_SSD1306 display(128, 64, &Wire, -1);
WebServer streamServer(81);          // 视频流服务，端口 81
SemaphoreHandle_t camMutex = NULL;   // 摄像头互斥锁（流/快照不能同时用）
volatile bool streamingActive = false;

// 串口模块
HardwareSerial co2Serial(1);         // JW01 二氧化碳 UART1
HardwareSerial feedSerial(2);        // SC7A20H 进食 UART2
uint8_t co2Frame[9];
int co2Idx = 0;
uint8_t feedBuf[32];
int feedIdx = 0;
float feedActivity = 0;

float temp = 0, hum = 0, co2 = 0;
int soilRaw = 0, lightRaw = 0, flame = 0;
unsigned long lastRead = 0, lastReport = 0, lastPage = 0, lastCam = 0;
int page = 0;
bool wifiOk = false, camOk = false;

// ==================== 摄像头初始化 ====================
bool initCamera() {
  camera_config_t c;
  c.ledc_channel = LEDC_CHANNEL_0;
  c.ledc_timer   = LEDC_TIMER_0;
  c.pin_d0 = CAM_D0;  c.pin_d1 = CAM_D1;
  c.pin_d2 = CAM_D2;  c.pin_d3 = CAM_D3;
  c.pin_d4 = CAM_D4;  c.pin_d5 = CAM_D5;
  c.pin_d6 = CAM_D6;  c.pin_d7 = CAM_D7;
  c.pin_xclk = CAM_XCLK;  c.pin_pclk = CAM_PCLK;
  c.pin_vsync = CAM_VSYNC;  c.pin_href = CAM_HREF;
  c.pin_sccb_sda = CAM_SIOD;  c.pin_sccb_scl = CAM_SIOC;
  c.pin_pwdn = CAM_PWDN;  c.pin_reset = CAM_RESET;
  c.xclk_freq_hz = 20000000;
  c.pixel_format = PIXFORMAT_JPEG;
  c.frame_size   = FRAMESIZE_QVGA;   // 320x240
  c.jpeg_quality = 35;
  c.fb_count     = 2;   // 流模式用 2 个缓冲更稳

  esp_err_t err = esp_camera_init(&c);
  if (err != ESP_OK) {
    Serial.printf("[摄像头] 初始化失败 0x%x（多半 PSRAM 没开或引脚接错）\n", err);
    return false;
  }
  // 画面镜像/翻转调整（如果画面是镜像的，把 hmirror 改成 0 或 vflip 改成 1）
  sensor_t* s = esp_camera_sensor_get();
  if (s) {
    s->set_hmirror(s, 1);   // 水平镜像
    s->set_vflip(s, 0);     // 垂直翻转（0=不翻转）
    Serial.println("[摄像头] 镜像已校正");
  }
  Serial.println("[摄像头] 就绪");
  return true;
}

String base64Encode(const uint8_t* data, size_t len) {
  size_t outLen = 4 * ((len + 2) / 3);
  uint8_t* out = (uint8_t*)malloc(outLen + 1);
  size_t olen = 0;
  mbedtls_base64_encode(out, outLen + 1, &olen, data, len);
  String s((char*)out, olen);
  free(out);
  return s;
}

// ==================== MJPEG 视频流 ====================
void handleStream() {
  WiFiClient client = streamServer.client();
  client.setNoDelay(true);   // 禁用 Nagle 算法，降低延迟、提升帧率
  client.println("HTTP/1.1 200 OK");
  client.println("Content-Type: multipart/x-mixed-replace; boundary=frame");
  client.println("Access-Control-Allow-Origin: *");
  client.println("Cache-Control: no-cache");
  client.println("Connection: close");
  client.println();

  streamingActive = true;
  while (client.connected()) {
    camera_fb_t* fb = NULL;
    if (camMutex && xSemaphoreTake(camMutex, pdMS_TO_TICKS(300)) == pdTRUE) {
      fb = esp_camera_fb_get();
      if (fb) {
        client.print("--frame\r\n");
        client.print("Content-Type: image/jpeg\r\n");
        client.print("Content-Length: " + String(fb->len) + "\r\n\r\n");
        client.write(fb->buf, fb->len);
        client.print("\r\n");
        esp_camera_fb_return(fb);
      }
      xSemaphoreGive(camMutex);
    }
    delay(fb ? 1 : 20);
  }
  streamingActive = false;
}

void streamTask(void* param) {
  for (;;) {
    streamServer.handleClient();
    delay(1);
  }
}

void setup() {
  Serial.begin(115200);
  delay(200);

  pinMode(PIN_FLAME, INPUT);
  dht.begin();

  // 串口模块：JW01 二氧化碳 + SC7A20H 进食检测
  co2Serial.begin(9600, SERIAL_8N1, PIN_CO2_RX, PIN_CO2_TX);
  feedSerial.begin(9600, SERIAL_8N1, PIN_FEED_RX, PIN_FEED_TX);

  Wire.begin(OLED_SDA, OLED_SCL);
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) Serial.println("OLED 失败");
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);

  camMutex = xSemaphoreCreateMutex();

  if (psramFound()) Serial.printf("[PSRAM] %d KB\n", ESP.getPsramSize() / 1024);
  else Serial.println("[PSRAM] 未找到！工具→PSRAM 选 OPI PSRAM");
  camOk = initCamera();

  Serial.print("连接 WiFi: ");
  WiFi.begin(ssid, password);
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 15000) { delay(300); Serial.print("."); }
  wifiOk = (WiFi.status() == WL_CONNECTED);
  Serial.println(wifiOk ? "\nWiFi 已连接" : "\nWiFi 失败");

  if (wifiOk) {
    Serial.printf("视频流地址: http://%s:81/stream\n", WiFi.localIP().toString().c_str());
    streamServer.on("/stream", handleStream);
    streamServer.begin();
    xTaskCreatePinnedToCore(streamTask, "camstream", 8192, NULL, 1, NULL, 1);
  }
}

void loop() {
  if (millis() - lastRead >= READ_INTERVAL) { lastRead = millis(); readSensors(); }
  if (millis() - lastPage >= PAGE_INTERVAL) { lastPage = millis(); page = (page + 1) % 3; drawDisplay(); }
  if (millis() - lastReport >= REPORT_INTERVAL) {
    lastReport = millis();
    if (WiFi.status() != WL_CONNECTED) reconnectWifi();
    if (WiFi.status() == WL_CONNECTED) reportEnv();
  }
  if (millis() - lastCam >= CAM_INTERVAL) {
    lastCam = millis();
    // 有浏览器在拉视频流时，跳过快照（避免抢摄像头）
    if (!streamingActive && camOk && WiFi.status() == WL_CONNECTED) captureAndUpload();
  }
}

// JW01 串口 CO2：9 字节帧，0x2C 开头，前 8 字节和 = 第 9 字节（校验）
float readCO2() {
  while (co2Serial.available()) {
    uint8_t b = co2Serial.read();
    if (co2Idx == 0 && b != 0x2C) continue;
    co2Frame[co2Idx++] = b;
    if (co2Idx >= 9) {
      uint8_t sum = 0;
      for (int i = 0; i < 8; i++) sum += co2Frame[i];
      Serial.print("[JW01] ");
      for (int i = 0; i < 9; i++) Serial.printf("%02X ", co2Frame[i]);
      Serial.printf("sum=%02X\n", sum);
      if (sum == co2Frame[8]) {
        co2 = (co2Frame[1] << 8) | co2Frame[2];
      }
      co2Idx = 0;
    }
  }
  return co2;
}

// SC7A20H 原始字节打印（先确认协议，再解析进食活动）
void readFeed() {
  while (feedSerial.available()) {
    feedBuf[feedIdx++] = feedSerial.read();
    if (feedIdx >= 32) {
      Serial.print("[SC7] ");
      for (int i = 0; i < 32; i++) Serial.printf("%02X ", feedBuf[i]);
      Serial.println();
      feedIdx = 0;
    }
  }
}

void readSensors() {
  temp = dht.readTemperature(); hum = dht.readHumidity();
  if (isnan(temp)) temp = 0; if (isnan(hum)) hum = 0;
  soilRaw = analogRead(PIN_SOIL);
  co2 = readCO2();
  readFeed();
  lightRaw = analogRead(PIN_LIGHT);
  flame = digitalRead(PIN_FLAME);
  Serial.printf("T=%.1fC H=%.0f%% | soil=%d co2=%.0f light=%d | flame=%d\n", temp, hum, soilRaw, co2, lightRaw, flame);
}

void drawDisplay() {
  display.clearDisplay();
  int soilPct = map(constrain(soilRaw, min(SOIL_DRY, SOIL_WET), max(SOIL_DRY, SOIL_WET)), min(SOIL_DRY, SOIL_WET), max(SOIL_DRY, SOIL_WET), 0, 100);
  int lightPct = map(constrain(lightRaw, 0, 4095), 0, 4095, 0, 100);
  if (page == 0) {
    display.setTextSize(2); display.setCursor(0, 4); display.print("T:"); display.print(temp, 1);
    display.setTextSize(1); display.setCursor(110, 12); display.print("C");
    display.setTextSize(2); display.setCursor(0, 34); display.print("H:"); display.print(hum, 0);
    display.setTextSize(1); display.setCursor(110, 42); display.print("%");
  } else if (page == 1) {
    display.setTextSize(1);
    display.setCursor(0, 4);  display.printf("Soil : %d%%", soilPct);
    display.setCursor(0, 22); display.printf("CO2  : %.0fppm", co2);
    display.setCursor(0, 40); display.printf("Light: %d%%", lightPct);
  } else {
    display.setTextSize(1);
    display.setCursor(0, 4);  display.print(flame == FLAME_ACTIVE ? "Flame: ALARM!" : "Flame: SAFE");
    display.setCursor(0, 22); display.print("Cam : "); display.print(camOk ? "OK" : "NO");
    display.setCursor(0, 40); display.print("WiFi: "); display.print(wifiOk ? "OK" : "NO");
  }
  display.display();
}

void reconnectWifi() {
  if (WiFi.status() == WL_CONNECTED) { wifiOk = true; return; }
  WiFi.disconnect(); WiFi.begin(ssid, password);
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 8000) delay(200);
  wifiOk = (WiFi.status() == WL_CONNECTED);
}

void reportEnv() {
  int soilPct = map(constrain(soilRaw, min(SOIL_DRY, SOIL_WET), max(SOIL_DRY, SOIL_WET)), min(SOIL_DRY, SOIL_WET), max(SOIL_DRY, SOIL_WET), 0, 100);
  int lightPct = map(constrain(lightRaw, 0, 4095), 0, 4095, 0, 100);
  int fire = (flame == FLAME_ACTIVE) ? 1 : 0;
  String localIp = WiFi.localIP().toString();
  HTTPClient http;
  http.begin(serverUrl);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(5000);
  String payload = "{\"device_id\":\"" + String(DEVICE_ID) + "\",\"name\":\"" + String(DEVICE_NAME) + "\","
    "\"temperature\":" + String(temp, 1) + ",\"humidity\":" + String(hum, 0) + ","
    "\"soil\":" + String(soilPct) + ",\"co2\":" + String(co2, 0) + ",\"light\":" + String(lightPct) + ",\"flame\":" + String(fire) + ","
    "\"local_ip\":\"" + localIp + "\",\"stream_port\":81}";
  int code = http.POST(payload);
  Serial.printf("[环境] HTTP %d\n", code);
  http.end();
}

void captureAndUpload() {
  if (camMutex && xSemaphoreTake(camMutex, pdMS_TO_TICKS(3000)) != pdTRUE) return;
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) { xSemaphoreGive(camMutex); Serial.println("[摄像头] 取帧失败"); return; }
  String b64 = base64Encode(fb->buf, fb->len);
  esp_camera_fb_return(fb);
  xSemaphoreGive(camMutex);

  HTTPClient http;
  http.begin(camUrl);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(6000);
  String payload = "{\"device_id\":\"esp32-01\",\"data\":\"" + b64 + "\"}";
  int code = http.POST(payload);
  Serial.printf("[摄像头] HTTP %d\n", code);
  http.end();
}
