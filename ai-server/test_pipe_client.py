import base64, json, struct, win32file
img = open(r"C:\Users\HUAWEI\Documents\deepseek-harness\default-workspace\origin-client-full\AI Server\sample.jpg", "rb").read()
req = {"op":"detect","image":base64.b64encode(img).decode(),"armor_conf":0.25,"car_conf":0.25,"iou_threshold":0.45,"max_size":1280}
payload=json.dumps(req).encode()
h=win32file.CreateFile(r"\\.\pipe\OriginDetectionPipe", win32file.GENERIC_READ|win32file.GENERIC_WRITE, 0, None, win32file.OPEN_EXISTING, 0, None)
win32file.WriteFile(h, struct.pack("<I", len(payload))+payload)
hr, data = win32file.ReadFile(h, 4)
(n,)=struct.unpack("<I", data)
hr, data = win32file.ReadFile(h, n)
r=json.loads(data.decode())
print(json.dumps({"success":r.get("success"),"count":r.get("count"),"provider":r.get("active_provider"),"ms":r.get("inference_time_ms"),"first":r.get("detections",[])[:2]},ensure_ascii=False))
