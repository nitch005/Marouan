import sys

with open('app.py', 'r', encoding='utf-8') as f:
    lines = f.readlines()

new_lines = []
skip = False
for i, line in enumerate(lines):
    if line.startswith('# Background Camera Thread Function'):
        skip = True
        new_lines.append('# Video Processing Endpoints\n')
        new_lines.append('import base64\n')
        new_lines.append('@app.route(\'/api/process_frame\', methods=[\'POST\'])\n')
        new_lines.append('def process_frame():\n')
        new_lines.append('    global active_mode, enroll_name, enroll_count, check_in_status, last_seen, recognizer, labels\n')
        new_lines.append('    try:\n')
        new_lines.append('        data = request.json\n')
        new_lines.append('        if not data or \'image\' not in data:\n')
        new_lines.append('            return jsonify({"error": "No image data"}), 400\n')
        new_lines.append('        \n')
        new_lines.append('        img_data = data["image"].split(",")[1]\n')
        new_lines.append('        nparr = np.frombuffer(base64.b64decode(img_data), np.uint8)\n')
        new_lines.append('        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)\n')
        new_lines.append('        if frame is None:\n')
        new_lines.append('            return jsonify({"error": "Invalid image data"}), 400\n')
        new_lines.append('        \n')
        new_lines.append('        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)\n')
        new_lines.append('        faces = cascade.detectMultiScale(gray, 1.2, 5)\n')
        new_lines.append('        \n')
        new_lines.append('        results = []\n')
        new_lines.append('        current_time = datetime.now()\n')
        new_lines.append('        seen_this_frame = {}\n')
        new_lines.append('        \n')
        new_lines.append('        for (x, y, w, h) in faces:\n')
        new_lines.append('            face_img = cv2.resize(gray[y:y+h, x:x+w], (200, 200))\n')
        new_lines.append('            \n')
        new_lines.append('            if active_mode == "enroll" and enroll_name:\n')
        new_lines.append('                person_dir = os.path.join(DATASET_DIR, enroll_name)\n')
        new_lines.append('                ensure_dir(person_dir)\n')
        new_lines.append('                img_path = os.path.join(person_dir, f"{enroll_count}.jpg")\n')
        new_lines.append('                cv2.imwrite(img_path, face_img)\n')
        new_lines.append('                enroll_count += 1\n')
        new_lines.append('                \n')
        new_lines.append('                if enroll_count >= enroll_max:\n')
        new_lines.append('                    active_mode = "attendance"\n')
        new_lines.append('                    import threading\n')
        new_lines.append('                    threading.Thread(target=train_model_backend).start()\n')
        new_lines.append('                    \n')
        new_lines.append('                results.append({\n')
        new_lines.append('                    "box": [int(x), int(y), int(w), int(h)],\n')
        new_lines.append('                    "label": f"Enrolling: {enroll_name} ({enroll_count}/{enroll_max})",\n')
        new_lines.append('                    "color": [0, 245, 255] # BGR format mapped to RGB on client\n')
        new_lines.append('                })\n')
        new_lines.append('            else:\n')
        new_lines.append('                name = "Unknown"\n')
        new_lines.append('                conf = 0.0\n')
        new_lines.append('                if recognizer is not None:\n')
        new_lines.append('                    try:\n')
        new_lines.append('                        label_id, confidence = recognizer.predict(face_img)\n')
        new_lines.append('                        if confidence < 75:\n')
        new_lines.append('                            name = labels.get(label_id, "Unknown")\n')
        new_lines.append('                            conf = confidence\n')
        new_lines.append('                    except Exception as e:\n')
        new_lines.append('                        pass\n')
        new_lines.append('                \n')
        new_lines.append('                if name != "Unknown":\n')
        new_lines.append('                    color = [135, 255, 0] # Vibrant green\n')
        new_lines.append('                    label_str = f"{name} ({conf:.1f})"\n')
        new_lines.append('                    seen_this_frame[name] = True\n')
        new_lines.append('                    last_seen[name] = current_time\n')
        new_lines.append('                    \n')
        new_lines.append('                    if name not in check_in_status or check_in_status[name] == "Checked-out":\n')
        new_lines.append('                        check_in_status[name] = "Checked-in"\n')
        new_lines.append('                        with open(CSV_PATH, "a", newline="") as f:\n')
        new_lines.append('                            csv.writer(f).writerow([current_time.strftime("%Y-%m-%d %H:%M:%S"), name, "Checked-in", f"{conf:.2f}"])\n')
        new_lines.append('                        \n')
        new_lines.append('                        name_snapshot_dir = os.path.join(SNAPSHOTS_DIR, name)\n')
        new_lines.append('                        ensure_dir(name_snapshot_dir)\n')
        new_lines.append('                        snapshot_filename = f"{current_time.strftime(\'%Y-%m-%d_%H-%M-%S\')}.jpg"\n')
        new_lines.append('                        cv2.imwrite(os.path.join(name_snapshot_dir, snapshot_filename), frame[y:y+h, x:x+w])\n')
        new_lines.append('                else:\n')
        new_lines.append('                    color = [255, 0, 0] # Red\n')
        new_lines.append('                    label_str = "Unknown"\n')
        new_lines.append('                    \n')
        new_lines.append('                results.append({\n')
        new_lines.append('                    "box": [int(x), int(y), int(w), int(h)],\n')
        new_lines.append('                    "label": label_str,\n')
        new_lines.append('                    "color": color\n')
        new_lines.append('                })\n')
        new_lines.append('                \n')
        new_lines.append('        for name in list(check_in_status.keys()):\n')
        new_lines.append('            if check_in_status[name] == "Checked-in" and name not in seen_this_frame:\n')
        new_lines.append('                if name in last_seen:\n')
        new_lines.append('                    time_since_last_seen = (current_time - last_seen[name]).total_seconds()\n')
        new_lines.append('                    if time_since_last_seen > 10:\n')
        new_lines.append('                        check_in_status[name] = "Checked-out"\n')
        new_lines.append('                        with open(CSV_PATH, "a", newline="") as f:\n')
        new_lines.append('                            csv.writer(f).writerow([current_time.strftime("%Y-%m-%d %H:%M:%S"), name, "Checked-out", ""])\n')
        new_lines.append('                            \n')
        new_lines.append('        return jsonify({"success": True, "faces": results})\n')
        new_lines.append('    except Exception as e:\n')
        new_lines.append('        return jsonify({"success": False, "error": str(e)}), 500\n')
        new_lines.append('\n')
        
    elif skip and line.startswith('# Background Training logic'):
        skip = False
        new_lines.append(line)
        continue
        
    elif line.startswith('@app.route(\'/video_feed\')'):
        skip = True
        continue
        
    elif skip and line.startswith('@app.route(\'/api/start_enroll\''):
        skip = False
        new_lines.append(line)
        continue
        
    elif line.startswith('@app.route(\'/api/cameras\''):
        skip = True
        continue
        
    elif skip and line.startswith('@app.route(\'/api/train_status\''):
        skip = False
        new_lines.append(line)
        continue

    if not skip:
        new_lines.append(line)

with open('app.py', 'w', encoding='utf-8') as f:
    f.writelines(new_lines)
