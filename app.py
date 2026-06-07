import os
import cv2
import csv
import numpy as np
from datetime import datetime
import threading
import time
import shutil
from flask import Flask, render_template, Response, jsonify, request, send_from_directory

app = Flask(__name__)

# Paths
DATASET_DIR = "dataset"
MODEL_PATH = "face_model.yml"
LABELS_PATH = "labels.txt"
LOGS_DIR = "logs"
CSV_PATH = os.path.join(LOGS_DIR, "attendance.csv")
SNAPSHOTS_DIR = os.path.join(LOGS_DIR, "snapshots")

# Create directories
def ensure_dir(path):
    if not os.path.exists(path):
        os.makedirs(path)

ensure_dir(DATASET_DIR)
ensure_dir(LOGS_DIR)
ensure_dir(SNAPSHOTS_DIR)

# Global variables for recognition & enrollment
lock = threading.Lock()
camera = None
latest_jpeg_bytes = None
active_mode = "attendance"  # "attendance" or "enroll"
enroll_name = ""
enroll_count = 0
enroll_max = 30

# State variables for check-in / check-out
check_in_status = {}  # {name: "Checked-in" | "Checked-out"}
last_seen = {}        # {name: datetime}
labels = {}           # {int_id: name}
recognizer = None
cascade = None

# Initialize Cascade Classifier
cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")

# Initialize and load model if it exists
def load_model():
    global recognizer, labels
    with lock:
        if os.path.exists(MODEL_PATH) and os.path.exists(LABELS_PATH):
            try:
                recognizer = cv2.face.LBPHFaceRecognizer_create()
                recognizer.read(MODEL_PATH)
                
                # Load labels
                labels = {}
                with open(LABELS_PATH, "r") as f:
                    for line in f:
                        if line.strip():
                            idx, name = line.strip().split(",")
                            labels[int(idx)] = name
                print(f"[INFO] Loaded model with {len(labels)} classes.")
                return True
            except Exception as e:
                print(f"[ERROR] Failed to load model: {e}")
                recognizer = None
        else:
            print("[INFO] No trained model found. System is in detection-only mode.")
            recognizer = None
    return False

load_model()

# Ensure CSV exists with header
if not os.path.exists(CSV_PATH):
    with open(CSV_PATH, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["timestamp", "name", "status", "confidence"])

# Background Camera Thread Function
def camera_thread_func():
    global camera, active_mode, enroll_name, enroll_count, check_in_status, last_seen, recognizer, labels, latest_jpeg_bytes
    
    # Initialize camera if not already done
    if camera is None or not camera.isOpened():
        camera = cv2.VideoCapture(0)
        
    while True:
        success, frame = camera.read()
        if not success:
            time.sleep(0.03)
            continue
            
        current_time = datetime.now()
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        faces = cascade.detectMultiScale(gray, 1.2, 5)
        
        # Track who was seen in this frame
        seen_this_frame = {}
        
        for (x, y, w, h) in faces:
            # Resize face for training / testing
            face_img = cv2.resize(gray[y:y+h, x:x+w], (200, 200))
            
            # Draw overlay depending on mode
            if active_mode == "enroll" and enroll_name:
                # Mode: Face Enrollment
                # 1. Draw box and enrollment status
                color = (255, 245, 0)  # Neon Cyan / Yellow
                cv2.rectangle(frame, (x, y), (x+w, y+h), color, 2)
                cv2.putText(frame, f"Enrolling: {enroll_name} ({enroll_count}/{enroll_max})", 
                            (x, y-10), cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)
                
                # 2. Capture frame
                person_dir = os.path.join(DATASET_DIR, enroll_name)
                ensure_dir(person_dir)
                img_path = os.path.join(person_dir, f"{enroll_count}.jpg")
                cv2.imwrite(img_path, face_img)
                enroll_count += 1
                
                # If done capturing, switch back to attendance mode
                if enroll_count >= enroll_max:
                    active_mode = "attendance"
                    # Train model in a separate thread automatically
                    threading.Thread(target=train_model_backend).start()
                    
            else:
                # Mode: Attendance Tracking
                name = "Unknown"
                conf = 0.0
                
                # If recognizer is loaded, make prediction
                if recognizer is not None:
                    try:
                        label_id, confidence = recognizer.predict(face_img)
                        # LBPH confidence: lower is better. Under 75 is a reasonable match.
                        if confidence < 75:
                            name = labels.get(label_id, "Unknown")
                            conf = confidence
                    except Exception as e:
                        print(f"[ERROR] Recognition error: {e}")
                        
                # Determine colors and label
                if name != "Unknown":
                    color = (0, 255, 135) # Vibrant success emerald green
                    label_str = f"{name} ({conf:.1f})"
                    seen_this_frame[name] = True
                    last_seen[name] = current_time
                    
                    # Log Check-in if not currently checked in
                    if name not in check_in_status or check_in_status[name] == "Checked-out":
                        check_in_status[name] = "Checked-in"
                        with open(CSV_PATH, "a", newline="") as f:
                            csv.writer(f).writerow([current_time.strftime("%Y-%m-%d %H:%M:%S"), name, "Checked-in", f"{conf:.2f}"])
                        print(f"[LOG] {current_time} - {name} Checked-in")
                        
                        # Capture and save check-in snapshot
                        name_snapshot_dir = os.path.join(SNAPSHOTS_DIR, name)
                        ensure_dir(name_snapshot_dir)
                        snapshot_filename = f"{current_time.strftime('%Y-%m-%d_%H-%M-%S')}.jpg"
                        cv2.imwrite(os.path.join(name_snapshot_dir, snapshot_filename), frame[y:y+h, x:x+w])
                else:
                    color = (0, 0, 255) # Red for Unknown / Unrecognized
                    label_str = "Unknown"
                    
                # Draw boxes
                cv2.rectangle(frame, (x, y), (x+w, y+h), color, 2)
                cv2.putText(frame, label_str, (x, y-10), cv2.FONT_HERSHEY_SIMPLEX, 0.7, color, 2)
        
        # Check for Check-outs
        # (If checked-in but not seen in this frame, and 10 seconds have elapsed)
        for name in list(check_in_status.keys()):
            if check_in_status[name] == "Checked-in" and name not in seen_this_frame:
                if name in last_seen:
                    time_since_last_seen = (current_time - last_seen[name]).total_seconds()
                    if time_since_last_seen > 10:
                        check_in_status[name] = "Checked-out"
                        with open(CSV_PATH, "a", newline="") as f:
                            csv.writer(f).writerow([current_time.strftime("%Y-%m-%d %H:%M:%S"), name, "Checked-out", ""])
                        print(f"[LOG] {current_time} - {name} Checked-out (timeout)")
                        
        # Render frame to JPEG bytes
        ret, jpeg = cv2.imencode('.jpg', frame)
        if ret:
            latest_jpeg_bytes = jpeg.tobytes()
        
        # Throttle to around 30 FPS
        time.sleep(0.03)

# Start background camera thread immediately
threading.Thread(target=camera_thread_func, daemon=True).start()

# Video Generator Function for Clients
def gen_frames():
    global latest_jpeg_bytes
    while True:
        if latest_jpeg_bytes is not None:
            yield (b'--frame\r\n'
                   b'Content-Type: image/jpeg\r\n\r\n' + latest_jpeg_bytes + b'\r\n')
        time.sleep(0.03)

# Background Training logic
training_in_progress = False
training_status = "idle"

def train_model_backend():
    global recognizer, training_in_progress, training_status
    if training_in_progress:
        return
        
    training_in_progress = True
    training_status = "training"
    print("[INFO] Starting face recognition model training...")
    
    try:
        faces_list, labels_list, names_list = [], [], []
        label_id = 0
        
        if not os.path.exists(DATASET_DIR) or len(os.listdir(DATASET_DIR)) == 0:
            print("[ERROR] No training directories found.")
            training_status = "error_no_dataset"
            training_in_progress = False
            return
            
        for person in sorted(os.listdir(DATASET_DIR)):
            person_path = os.path.join(DATASET_DIR, person)
            if not os.path.isdir(person_path):
                continue
                
            img_files = os.listdir(person_path)
            if len(img_files) == 0:
                continue
                
            names_list.append(person)
            for img_file in img_files:
                img_path = os.path.join(person_path, img_file)
                img = cv2.imread(img_path, cv2.IMREAD_GRAYSCALE)
                if img is None:
                    continue
                faces_list.append(cv2.resize(img, (200, 200)))
                labels_list.append(label_id)
            label_id += 1

        if len(faces_list) == 0:
            print("[ERROR] No valid face images found for training.")
            training_status = "error_no_faces"
            training_in_progress = False
            return
            
        # Train LBPH Face Recognizer
        new_recognizer = cv2.face.LBPHFaceRecognizer_create()
        new_recognizer.train(faces_list, np.array(labels_list))
        new_recognizer.save(MODEL_PATH)
        
        # Save labels file
        with open(LABELS_PATH, "w") as f:
            for i, name in enumerate(names_list):
                f.write(f"{i},{name}\n")
                
        print("[SUCCESS] Model trained and saved.")
        training_status = "success"
        
        # Reload the trained model into active recognition
        load_model()
        
    except Exception as e:
        print(f"[ERROR] Exception during training: {e}")
        training_status = f"error: {str(e)}"
        
    finally:
        training_in_progress = False

# Web Application Routes
@app.route('/')
def index():
    return render_template("index.html")

@app.route('/video_feed')
def video_feed():
    return Response(gen_frames(),
                    mimetype='multipart/x-mixed-replace; boundary=frame')

@app.route('/api/start_enroll', methods=['POST'])
def start_enroll():
    global active_mode, enroll_name, enroll_count
    data = request.get_json() or {}
    name = data.get("name", "").strip()
    
    if not name or len(name) < 3:
        return jsonify({"success": False, "message": "Name must be at least 3 characters."}), 400
        
    # Standardize name for directory creation
    name = "".join(c for c in name if c.isalnum() or c in (' ', '_', '-')).strip()
    
    # Path traversal and long name protection
    name = name[:50]
    
    # Check if directory exists and is populated
    person_dir = os.path.join(DATASET_DIR, name)
    if os.path.exists(person_dir) and len(os.listdir(person_dir)) > 0:
        # User exists, let's ask if they want to overwrite or add
        overwrite = data.get("overwrite", False)
        if not overwrite:
            return jsonify({
                "success": False, 
                "requires_confirmation": True, 
                "message": f"Person '{name}' already exists. Overwrite dataset?"
            })
        else:
            # Overwrite: clear directory first
            shutil.rmtree(person_dir)
            
    ensure_dir(person_dir)
    
    # Set global enrollment states
    global active_mode, enroll_name, enroll_count
    with lock:
        enroll_name = name
        enroll_count = 0
        active_mode = "enroll"
        
    return jsonify({"success": True, "message": f"Enrollment session started for {name}."})

@app.route('/api/enroll_status', methods=['GET'])
def enroll_status():
    global active_mode, enroll_name, enroll_count, enroll_max
    return jsonify({
        "active": active_mode == "enroll",
        "name": enroll_name,
        "count": enroll_count,
        "max": enroll_max
    })

@app.route('/api/cancel_enroll', methods=['POST'])
def cancel_enroll():
    global active_mode, enroll_name, enroll_count
    with lock:
        active_mode = "attendance"
        enroll_name = ""
        enroll_count = 0
    return jsonify({"success": True, "message": "Enrollment cancelled."})

@app.route('/api/train', methods=['POST'])
def train_model():
    global training_in_progress
    if training_in_progress:
        return jsonify({"success": False, "message": "Training already in progress."})
        
    threading.Thread(target=train_model_backend).start()
    return jsonify({"success": True, "message": "Training scheduled in the background."})

@app.route('/api/train_status', methods=['GET'])
def get_train_status():
    global training_in_progress, training_status
    return jsonify({
        "training": training_in_progress,
        "status": training_status
    })

@app.route('/api/logs', methods=['GET'])
def get_logs():
    if not os.path.exists(CSV_PATH):
        return jsonify({"logs": [], "total": 0, "page": 1, "pages": 1}) if request.args.get('page') else jsonify([])
        
    logs_data = []
    try:
        with open(CSV_PATH, "r") as f:
            reader = csv.reader(f)
            header = next(reader, None)
            if header:
                for row in reader:
                    if len(row) >= 3:
                        # row = [timestamp, name, status, confidence]
                        conf = row[3] if len(row) > 3 else ""
                        logs_data.append({
                            "timestamp": row[0],
                            "name": row[1],
                            "status": row[2],
                            "confidence": conf
                        })
    except Exception as e:
        print(f"[ERROR] Error reading CSV: {e}")
        
    # Filtering by date
    start_date = request.args.get('start_date')
    end_date = request.args.get('end_date')
    if start_date or end_date:
        filtered_logs = []
        for log in logs_data:
            log_date = log["timestamp"].split()[0]
            if start_date and log_date < start_date:
                continue
            if end_date and log_date > end_date:
                continue
            filtered_logs.append(log)
        logs_data = filtered_logs

    # Sorting
    sort_by = request.args.get('sort_by', 'timestamp') # timestamp, name, confidence
    sort_order = request.args.get('sort_order', 'desc') # asc, desc
    
    reverse_sort = (sort_order == 'desc')
    
    if sort_by == 'confidence':
        logs_data.sort(key=lambda x: float(x["confidence"]) if x["confidence"] else 0, reverse=reverse_sort)
    elif sort_by == 'name':
        logs_data.sort(key=lambda x: x["name"].lower(), reverse=reverse_sort)
    else: # timestamp
        logs_data.sort(key=lambda x: x["timestamp"], reverse=reverse_sort)
    
    # Check if pagination is requested
    limit_arg = request.args.get('limit')
    page_arg = request.args.get('page')
    
    if page_arg and limit_arg:
        try:
            page = int(page_arg)
            limit = int(limit_arg)
        except ValueError:
            page = 1
            limit = 20
        
        total = len(logs_data)
        pages = (total + limit - 1) // limit if total > 0 else 1
        page = max(1, min(page, pages))
        
        start_idx = (page - 1) * limit
        end_idx = start_idx + limit
        paginated_logs = logs_data[start_idx:end_idx]
        
        return jsonify({
            "logs": paginated_logs,
            "total": total,
            "page": page,
            "pages": pages
        })
    elif limit_arg:
        try:
            limit = int(limit_arg)
            return jsonify(logs_data[:limit])
        except ValueError:
            return jsonify(logs_data)
    else:
        return jsonify(logs_data)

@app.route('/api/members', methods=['GET'])
def get_members():
    members_list = []
    if os.path.exists(DATASET_DIR):
        for name in sorted(os.listdir(DATASET_DIR)):
            dir_path = os.path.join(DATASET_DIR, name)
            if os.path.isdir(dir_path):
                img_count = len(os.listdir(dir_path))
                members_list.append({
                    "name": name,
                    "image_count": img_count
                })
    return jsonify(members_list)

@app.route('/api/member_details/<name>', methods=['GET'])
def get_member_details(name):
    person_dir = os.path.join(DATASET_DIR, name)
    if not os.path.exists(person_dir):
        return jsonify({"success": False, "message": "Member not found"}), 404
        
    images = os.listdir(person_dir)
    image_urls = [f"/dataset/{name}/{img}" for img in images]
    
    # Calculate stats
    total_checkins = 0
    conf_sum = 0
    conf_count = 0
    
    if os.path.exists(CSV_PATH):
        try:
            with open(CSV_PATH, "r") as f:
                reader = csv.reader(f)
                next(reader, None)
                for row in reader:
                    if len(row) >= 3 and row[1] == name and row[2] == "Checked-in":
                        total_checkins += 1
                        if len(row) > 3 and row[3]:
                            conf_sum += float(row[3])
                            conf_count += 1
        except:
            pass
            
    avg_conf = (conf_sum / conf_count) if conf_count > 0 else 0
    
    return jsonify({
        "success": True,
        "name": name,
        "total_checkins": total_checkins,
        "avg_confidence": round(avg_conf, 1),
        "images": image_urls
    })

@app.route('/dataset/<name>/<filename>')
def serve_dataset_image(name, filename):
    return send_from_directory(os.path.join(DATASET_DIR, name), filename)

@app.route('/api/analytics', methods=['GET'])
def get_analytics():
    if not os.path.exists(CSV_PATH):
        return jsonify({"labels": [], "data": []})
        
    # Get last 7 days check-in counts
    try:
        from collections import defaultdict
        counts = defaultdict(int)
        with open(CSV_PATH, "r") as f:
            reader = csv.reader(f)
            header = next(reader, None)
            if header:
                for row in reader:
                    if len(row) >= 3 and row[2] == "Checked-in":
                        date_str = row[0].split()[0] # get YYYY-MM-DD
                        counts[date_str] += 1
                        
        # Sort dates
        sorted_dates = sorted(counts.keys())[-7:] # last 7 days
        labels = []
        data = []
        for d in sorted_dates:
            labels.append(d)
            data.append(counts[d])
            
        return jsonify({"labels": labels, "data": data})
    except Exception as e:
        print(f"[ERROR] Analytics error: {e}")
        return jsonify({"labels": [], "data": []})

@app.route('/api/members/<name>', methods=['DELETE'])
def delete_member(name):
    person_dir = os.path.join(DATASET_DIR, name)
    if not os.path.exists(person_dir):
        return jsonify({"success": False, "message": f"Member {name} not found."}), 404
        
    try:
        # Delete dataset images
        shutil.rmtree(person_dir)
        
        # Also clean up snapshots if any
        snapshot_dir = os.path.join(SNAPSHOTS_DIR, name)
        if os.path.exists(snapshot_dir):
            shutil.rmtree(snapshot_dir)
            
        print(f"[INFO] Deleted member {name} from datasets.")
        
        # Retrain model since dataset changed
        train_model_backend()
        
        return jsonify({"success": True, "message": f"Member '{name}' deleted and model retrained."})
    except Exception as e:
        return jsonify({"success": False, "message": f"Failed to delete member: {e}"}), 500

# Route to serve snapshots dynamically
@app.route('/snapshots/<name>/<filename>')
def serve_snapshot(name, filename):
    return send_from_directory(os.path.join(SNAPSHOTS_DIR, name), filename)

# Clean checkout on shutdown
def checkout_all():
    global check_in_status
    current_time = datetime.now()
    checked_out_count = 0
    for name, status in check_in_status.items():
        if status == "Checked-in":
            with open(CSV_PATH, "a", newline="") as f:
                csv.writer(f).writerow([current_time.strftime("%Y-%m-%d %H:%M:%S"), name, "Checked-out", ""])
            print(f"[LOG] {current_time} - {name} Checked-out (system exit)")
            checked_out_count += 1
    if checked_out_count > 0:
        print(f"[INFO] Checked out {checked_out_count} active users on exit.")

if __name__ == "__main__":
    import atexit
    atexit.register(checkout_all)
    
    print("[INFO] Starting Flask face recognition system on http://127.0.0.1:5000")
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)
