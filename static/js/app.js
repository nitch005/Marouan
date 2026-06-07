// Global App Controllers
document.addEventListener("DOMContentLoaded", () => {
    // Current local date display
    updateHeaderDate();
    setInterval(updateHeaderDate, 60000);

    // Active polling intervals
    let logsInterval = null;
    let enrollInterval = null;
    let statsInterval = null;

    // Nav Items
    const navItems = document.querySelectorAll(".nav-item");
    const viewSections = document.querySelectorAll(".view-section");
    
    // Analytics Chart
    let analyticsChart = null;
    function initChart(labels, data) {
        const ctx = document.getElementById('analyticsChart');
        if (!ctx) return;
        if (analyticsChart) {
            analyticsChart.data.labels = labels;
            analyticsChart.data.datasets[0].data = data;
            analyticsChart.update();
            return;
        }
        analyticsChart = new Chart(ctx.getContext('2d'), {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Check-ins',
                    data: data,
                    borderColor: '#8b5cf6',
                    backgroundColor: 'rgba(139, 92, 246, 0.25)',
                    borderWidth: 3,
                    tension: 0.4,
                    fill: true
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    y: { beginAtZero: true, ticks: { stepSize: 1, color: '#94a3b8' }, grid: { color: 'rgba(255, 255, 255, 0.05)' } },
                    x: { ticks: { color: '#94a3b8' }, grid: { display: false } }
                }
            }
        });
    }

    // Elements
    const navButtons = document.querySelectorAll(".nav-btn");
    const globalStatusText = document.getElementById("global-status-text");
    const globalStatusDot = document.querySelector(".status-indicator-dot");

    // Views
    const mainWebcamImg = document.getElementById("main-webcam-img");
    const enrollWebcamImg = document.getElementById("enroll-webcam-img");

    // Stat targets
    const statTotalRegistered = document.getElementById("stat-total-registered");
    const statTotalCheckedin = document.getElementById("stat-total-checkedin");
    const statLatestSeen = document.getElementById("stat-latest-seen");

    // 1. Navigation Panel Switching
    navButtons.forEach(button => {
        button.addEventListener("click", () => {
            const targetId = button.getAttribute("data-target");

            // Deactivate all navs & views
            navButtons.forEach(btn => btn.classList.remove("active"));
            viewSections.forEach(section => section.classList.remove("active"));

            // Activate current
            button.classList.add("active");
            document.getElementById(targetId).classList.add("active");

            // Optimizing video stream network overhead
            // Stop stream in inactive views, start in active to save CPU/Bandwidth
            if (targetId === "dashboard-view") {
                mainWebcamImg.src = "/video_feed";
                enrollWebcamImg.src = "";
                startDashboardPolling();
            } else if (targetId === "enroll-view") {
                mainWebcamImg.src = "";
                enrollWebcamImg.src = "/video_feed";
                stopDashboardPolling();
            } else {
                mainWebcamImg.src = "";
                enrollWebcamImg.src = "";
                stopDashboardPolling();
                
                if (targetId === "logs-view") {
                    fetchLogs();
                } else if (targetId === "members-view") {
                    fetchMembers();
                }
            }
        });
    });

    // Initialize Active View
    mainWebcamImg.src = "/video_feed";
    
    // Modal Logic
    const profileModal = document.getElementById("profile-modal");
    const closeProfileModal = document.getElementById("close-profile-modal");
    
    if (closeProfileModal) {
        closeProfileModal.addEventListener("click", () => {
            profileModal.style.display = "none";
        });
    }
    
    async function openProfileModal(name) {
        document.getElementById("profile-name").innerText = name;
        document.getElementById("profile-checkins").innerText = "...";
        document.getElementById("profile-confidence").innerText = "...";
        document.getElementById("profile-gallery").innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Loading...`;
        
        profileModal.style.display = "flex";
        
        try {
            const res = await fetch(`/api/member_details/${name}`);
            const data = await res.json();
            
            if (data.success) {
                document.getElementById("profile-checkins").innerText = data.total_checkins;
                document.getElementById("profile-confidence").innerText = data.avg_confidence + "%";
                
                const gallery = document.getElementById("profile-gallery");
                gallery.innerHTML = "";
                data.images.forEach(imgUrl => {
                    const img = document.createElement("img");
                    img.src = imgUrl;
                    img.style.height = "100px";
                    img.style.borderRadius = "8px";
                    gallery.appendChild(img);
                });
            } else {
                document.getElementById("profile-gallery").innerHTML = "Error loading profile.";
            }
        } catch (e) {
            document.getElementById("profile-gallery").innerHTML = "Error connecting to server.";
        }
    }

    let currentStream = null;
    let webcamInterval = null;

    async function initWebcam(deviceId = null) {
        const constraints = {
            video: deviceId ? { deviceId: { exact: deviceId } } : true
        };
        try {
            if (currentStream) {
                currentStream.getTracks().forEach(t => t.stop());
            }
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            currentStream = stream;
            
            document.getElementById("main-webcam-video").srcObject = stream;
            document.getElementById("enroll-webcam-video").srcObject = stream;
            
            // Populate camera selector if not already done
            if (!deviceId) {
                const devices = await navigator.mediaDevices.enumerateDevices();
                const videoDevices = devices.filter(d => d.kind === 'videoinput');
                const select = document.getElementById("camera-select");
                if (select) {
                    select.innerHTML = '';
                    videoDevices.forEach((device, index) => {
                        const opt = document.createElement("option");
                        opt.value = device.deviceId;
                        opt.textContent = device.label || `Camera ${index + 1}`;
                        select.appendChild(opt);
                    });
                    
                    select.onchange = (e) => {
                        initWebcam(e.target.value);
                    };
                }
            }
            
            startFrameProcessing();
        } catch (e) {
            console.error("Camera access denied or error:", e);
        }
    }

    function startFrameProcessing() {
        if (webcamInterval) clearInterval(webcamInterval);
        
        // Use a hidden offscreen canvas to extract frames
        const offscreenCanvas = document.createElement("canvas");
        offscreenCanvas.width = 640;
        offscreenCanvas.height = 480;
        const ctx = offscreenCanvas.getContext("2d");
        
        webcamInterval = setInterval(async () => {
            // Determine active video element
            const mainVideo = document.getElementById("main-webcam-video");
            const enrollVideo = document.getElementById("enroll-webcam-video");
            
            let activeVideo = mainVideo;
            let activeCanvas = document.getElementById("main-webcam-canvas");
            
            if (document.getElementById("view-enroll").classList.contains("active")) {
                activeVideo = enrollVideo;
                activeCanvas = document.getElementById("enroll-webcam-canvas");
            }
            
            if (activeVideo.readyState === activeVideo.HAVE_ENOUGH_DATA) {
                // Draw current frame to offscreen canvas
                ctx.drawImage(activeVideo, 0, 0, offscreenCanvas.width, offscreenCanvas.height);
                const jpegData = offscreenCanvas.toDataURL("image/jpeg", 0.7);
                
                try {
                    const res = await fetch("/api/process_frame", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ image: jpegData })
                    });
                    const data = await res.json();
                    
                    if (data.success) {
                        drawOverlays(activeCanvas, activeVideo, data.faces);
                    }
                } catch (e) {
                    // Fail silently for network dropped frames
                }
            }
        }, 150); // ~7 FPS to reduce backend load
    }

    function drawOverlays(canvas, video, faces) {
        // Match canvas size to video display size
        canvas.width = video.clientWidth;
        canvas.height = video.clientHeight;
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        // Calculate scale since backend processes at 640x480 max
        // Wait, drawImage scales the video to 640x480!
        const scaleX = canvas.width / 640;
        const scaleY = canvas.height / 480;
        
        faces.forEach(f => {
            const [x, y, w, h] = f.box;
            const sx = x * scaleX;
            const sy = y * scaleY;
            const sw = w * scaleX;
            const sh = h * scaleY;
            
            const colorRGB = `rgb(${f.color[0]}, ${f.color[1]}, ${f.color[2]})`;
            
            ctx.strokeStyle = colorRGB;
            ctx.lineWidth = 3;
            // The canvas is flipped in CSS, so drawing normally will flip it properly visually.
            ctx.strokeRect(sx, sy, sw, sh);
            
            // Name label (since canvas is flipped in CSS, text will be backwards unless we flip it locally here, but wait! The video and canvas are flipped. So text drawn on canvas will be backwards!)
            // To fix this, we should flip the canvas context before drawing text.
            ctx.save();
            ctx.translate(sx + sw/2, sy);
            ctx.scale(-1, 1);
            ctx.fillStyle = colorRGB;
            ctx.font = "16px Inter, sans-serif";
            ctx.textAlign = "center";
            ctx.fillText(f.label, 0, -10);
            ctx.restore();
        });
    }

    initWebcam();
    startDashboardPolling();

    // 2. Poll statistics and activity tickers
    function startDashboardPolling() {
        fetchDashboardStats();
        fetchLiveActivity();
        
        // Clear previous intervals to avoid stacking
        clearInterval(logsInterval);
        clearInterval(statsInterval);
        
        logsInterval = setInterval(fetchLiveActivity, 2000);
        statsInterval = setInterval(fetchDashboardStats, 4000);
    }

    function stopDashboardPolling() {
        clearInterval(logsInterval);
        clearInterval(statsInterval);
    }

    // Update Header Date
    function updateHeaderDate() {
        const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
        document.getElementById("live-date").innerText = new Date().toLocaleDateString('en-US', options);
    }

    // 3. Fetch Dashboard Stats
    async function fetchDashboardStats() {
        try {
            // Get members list
            const membersRes = await fetch("/api/members");
            const members = await membersRes.json();
            statTotalRegistered.innerText = members.length;

            // Get analytics data
            try {
                const analyticsRes = await fetch("/api/analytics");
                const analyticsData = await analyticsRes.json();
                initChart(analyticsData.labels, analyticsData.data);
            } catch (e) {
                console.error("Failed to fetch analytics", e);
            }

            // Get logs to compute checked-in status count (fetch up to 1000 latest to optimize)
            const logsRes = await fetch("/api/logs?limit=1000");
            const logs = await logsRes.json();

            // Track active checked in
            const seenActive = {};
            let checkedInCount = 0;
            let lastSeenPerson = "None";

            for (const log of logs) {
                const name = log.name;
                if (!seenActive[name]) {
                    seenActive[name] = true;
                    if (log.status === "Checked-in") {
                        checkedInCount++;
                        if (lastSeenPerson === "None") {
                            lastSeenPerson = `${name} (${log.timestamp.split(" ")[1]})`;
                        }
                    }
                }
            }

            statTotalCheckedin.innerText = checkedInCount;
            statLatestSeen.innerText = lastSeenPerson;

        } catch (e) {
            console.error("Error fetching stats:", e);
        }
    }

    // 4. Fetch Live Activity Stream Ticker
    async function fetchLiveActivity() {
        try {
            const res = await fetch("/api/logs?limit=10");
            const logs = await res.json();
            
            const activityList = document.getElementById("dashboard-activity-list");
            if (!logs || logs.length === 0) {
                activityList.innerHTML = `
                    <div class="empty-state">
                        <i class="fa-solid fa-user-slash"></i>
                        <p>No activity logs found. Try enrolling first!</p>
                    </div>`;
                return;
            }

            // Display latest 6 events
            const latestLogs = logs.slice(0, 6);
            let html = "";
            
            latestLogs.forEach(log => {
                const isCheckin = log.status === "Checked-in";
                const actionClass = isCheckin ? "check-in" : "check-out";
                const avatarChar = log.name.charAt(0).toUpperCase();
                const formattedTime = log.timestamp.split(" ")[1]; // extract HH:MM:SS
                
                html += `
                    <div class="activity-item">
                        <div class="activity-user ${actionClass}">
                            <div class="user-avatar-placeholder">${avatarChar}</div>
                            <div class="user-meta">
                                <h4>${log.name}</h4>
                                <p>${log.timestamp.split(" ")[0]}</p>
                            </div>
                        </div>
                        <div class="activity-action">
                            <span class="badge-status ${isCheckin ? 'checked-in' : 'checked-out'}">${log.status}</span>
                            <span class="activity-time">${formattedTime}</span>
                        </div>
                    </div>`;
            });
            
            activityList.innerHTML = html;

        } catch (e) {
            console.error("Error fetching logs stream:", e);
        }
    }

    // 5. Face Enrollment Wizard Handler
    const enrollForm = document.getElementById("enroll-form");
    const btnStartEnroll = document.getElementById("btn-start-enroll");
    const btnCancelEnroll = document.getElementById("btn-cancel-enroll");
    const captureProgressArea = document.getElementById("capture-progress-area");
    const enrollProgressCircle = document.getElementById("enroll-progress-circle");
    const enrollProgressPercent = document.getElementById("enroll-progress-percent");
    const enrollProgressCounter = document.getElementById("enroll-progress-counter");
    const enrollNameInput = document.getElementById("enroll-name");
    const enrollModeBadge = document.getElementById("enroll-mode-badge");

    // Circle dash calculation elements
    const radius = enrollProgressCircle.r.baseVal.value;
    const circumference = radius * 2 * Math.PI;
    
    function setProgress(percent) {
        const offset = circumference - (percent / 100) * circumference;
        enrollProgressCircle.style.strokeDashoffset = offset;
        enrollProgressPercent.innerText = `${Math.round(percent)}%`;
    }

    enrollForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const name = enrollNameInput.value.trim();
        if (!name) return;

        // Reset elements
        setProgress(0);
        btnStartEnroll.disabled = true;
        btnStartEnroll.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Initializing...`;
        
        try {
            let response = await fetch("/api/start_enroll", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: name })
            });
            
            let result = await response.json();

            // Handshake for overwriting existing dataset
            if (result.requires_confirmation) {
                if (confirm(result.message)) {
                    response = await fetch("/api/start_enroll", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ name: name, overwrite: true })
                    });
                    result = await response.json();
                } else {
                    // Canceled by user
                    resetEnrollFormState();
                    return;
                }
            }

            if (result.success) {
                // Enrollment mode started successfully
                globalStatusText.innerText = "Capturing Face Samples...";
                globalStatusDot.className = "status-indicator-dot enrolling";
                enrollModeBadge.innerText = "ENROLLING MODE";
                enrollModeBadge.className = "badge badge-purple";
                
                // Show cancel button, show progress area
                btnCancelEnroll.classList.remove("hidden");
                captureProgressArea.classList.remove("hidden");
                
                // Keep input locked during acquisition
                enrollNameInput.disabled = true;
                
                // Start polling capture frames status
                clearInterval(enrollInterval);
                enrollInterval = setInterval(pollEnrollProgress, 300);
            } else {
                alert(result.message || "Failed to start enrollment.");
                resetEnrollFormState();
            }

        } catch (err) {
            console.error("Enrollment error:", err);
            alert("Connection error starting enrollment.");
            resetEnrollFormState();
        }
    });

    btnCancelEnroll.addEventListener("click", async () => {
        try {
            await fetch("/api/cancel_enroll", { method: "POST" });
            resetEnrollFormState();
        } catch (e) {
            console.error("Error canceling enrollment:", e);
        }
    });

    function resetEnrollFormState() {
        clearInterval(enrollInterval);
        btnStartEnroll.disabled = false;
        btnStartEnroll.innerHTML = `<i class="fa-solid fa-camera"></i> <span>Start Face Capture</span>`;
        btnCancelEnroll.classList.add("hidden");
        captureProgressArea.classList.add("hidden");
        enrollNameInput.disabled = false;
        enrollNameInput.value = "";
        setProgress(0);
        
        globalStatusText.innerText = "Active & Logging";
        globalStatusDot.className = "status-indicator-dot online";
        enrollModeBadge.innerText = "Attendance Mode";
        enrollModeBadge.className = "badge badge-cyan";
    }

    async function pollEnrollProgress() {
        try {
            const res = await fetch("/api/enroll_status");
            const status = await res.json();

            if (status.active) {
                const count = status.count;
                const max = status.max;
                const percent = (count / max) * 100;
                
                setProgress(percent);
                enrollProgressCounter.innerText = `${count} / ${max} Images`;
            } else {
                // Enrollment finished capturing! Backend automatically started training!
                clearInterval(enrollInterval);
                showLoadingOverlay("Optimizing Biometrics", "Adding face vectors to LBPH model and rebuilding network...");
                pollTrainingStatus();
            }

        } catch (e) {
            console.error("Error polling enrollment:", e);
        }
    }

    // 6. Polling Training Progress
    async function pollTrainingStatus() {
        const interval = setInterval(async () => {
            try {
                const res = await fetch("/api/train_status");
                const state = await res.json();

                if (!state.training) {
                    clearInterval(interval);
                    hideLoadingOverlay();
                    
                    if (state.status === "success") {
                        alert("Biometric dataset trained successfully! Profile is active.");
                    } else {
                        alert("Biometric Model update failed: " + state.status);
                    }
                    resetEnrollFormState();
                    // Go to dashboard view automatically
                    document.getElementById("nav-dashboard").click();
                }
            } catch (e) {
                console.error("Error checking training status:", e);
                clearInterval(interval);
                hideLoadingOverlay();
                resetEnrollFormState();
            }
        }, 1000);
    }

    // Helper: System Loading Overlays
    const loadingOverlay = document.getElementById("loading-overlay");
    const loadingOverlayTitle = document.getElementById("loading-overlay-title");
    const loadingOverlayDesc = document.getElementById("loading-overlay-desc");

    function showLoadingOverlay(title, desc) {
        loadingOverlayTitle.innerText = title;
        loadingOverlayDesc.innerText = desc;
        loadingOverlay.classList.add("active");
    }

    function hideLoadingOverlay() {
        loadingOverlay.classList.remove("active");
    }

    // Header Brain Train Button
    document.getElementById("btn-quick-train").addEventListener("click", async () => {
        if (confirm("Force rebuild and train LBPH face recognition neural mapping?")) {
            showLoadingOverlay("Training LBPH AI Model", "Analyzing registered facial metrics. Re-calculating Local Binary Pattern histograms...");
            try {
                const res = await fetch("/api/train", { method: "POST" });
                const result = await res.json();
                if (result.success) {
                    pollTrainingStatus();
                } else {
                    alert(result.message);
                    hideLoadingOverlay();
                }
            } catch (e) {
                console.error("Error manual training:", e);
                hideLoadingOverlay();
            }
        }
    });

    // 7. Attendance Log Database view
    const logsTableBody = document.getElementById("logs-table-body");
    const logSearchInput = document.getElementById("log-search-input");
    const logStatusFilter = document.getElementById("log-status-filter");
    const btnRefreshLogs = document.getElementById("btn-refresh-logs");
    const logDateFilter = document.getElementById("log-date-filter");
    
    let dateRange = { start: "", end: "" };
    if (logDateFilter) {
        flatpickr(logDateFilter, {
            mode: "range",
            dateFormat: "Y-m-d",
            onChange: function(selectedDates, dateStr, instance) {
                if (selectedDates.length === 2) {
                    dateRange.start = instance.formatDate(selectedDates[0], "Y-m-d");
                    dateRange.end = instance.formatDate(selectedDates[1], "Y-m-d");
                    logsCurrentPage = 1;
                    fetchLogs();
                } else if (selectedDates.length === 0) {
                    dateRange = { start: "", end: "" };
                    logsCurrentPage = 1;
                    fetchLogs();
                }
            }
        });
    }

    // Sort state
    let logsSortBy = "timestamp";
    let logsSortOrder = "desc";
    
    document.querySelectorAll(".sortable").forEach(th => {
        th.addEventListener("click", () => {
            const field = th.getAttribute("data-sort");
            if (logsSortBy === field) {
                logsSortOrder = logsSortOrder === "desc" ? "asc" : "desc";
            } else {
                logsSortBy = field;
                logsSortOrder = "desc";
            }
            logsCurrentPage = 1;
            fetchLogs();
        });
    });
    
    // Pagination state
    let logsCurrentPage = 1;
    const logsLimit = 20;
    const btnPrevPage = document.getElementById("btn-prev-page");
    const btnNextPage = document.getElementById("btn-next-page");
    const paginationInfo = document.getElementById("pagination-info");
    
    let cachedLogs = [];

    btnRefreshLogs.addEventListener("click", () => { logsCurrentPage = 1; fetchLogs(); });
    logSearchInput.addEventListener("input", filterLogs);
    logStatusFilter.addEventListener("change", filterLogs);
    
    if(btnPrevPage) {
        btnPrevPage.addEventListener("click", () => {
            if (logsCurrentPage > 1) {
                logsCurrentPage--;
                fetchLogs();
            }
        });
    }
    
    if(btnNextPage) {
        btnNextPage.addEventListener("click", () => {
            logsCurrentPage++;
            fetchLogs();
        });
    }

    async function fetchLogs() {
        logsTableBody.innerHTML = `
            <tr>
                <td colspan="5" class="table-loading">
                    <i class="fa-solid fa-spinner fa-spin"></i> Refreshing attendance database...
                </td>
            </tr>`;
            
        try {
            let url = `/api/logs?page=${logsCurrentPage}&limit=${logsLimit}&sort_by=${logsSortBy}&sort_order=${logsSortOrder}`;
            if (dateRange.start && dateRange.end) {
                url += `&start_date=${dateRange.start}&end_date=${dateRange.end}`;
            }
            const res = await fetch(url);
            const data = await res.json();
            
            // The API returns pagination metadata and logs array
            cachedLogs = data.logs || [];
            
            if (btnPrevPage && btnNextPage && paginationInfo) {
                paginationInfo.innerText = `Page ${data.page} of ${data.pages}`;
                btnPrevPage.disabled = data.page <= 1;
                btnNextPage.disabled = data.page >= data.pages;
                logsCurrentPage = data.page;
            }
            
            renderLogs(cachedLogs);
        } catch (e) {
            console.error("Error reading database logs:", e);
            logsTableBody.innerHTML = `
                <tr>
                    <td colspan="5" class="table-loading" style="color:var(--danger)">
                        <i class="fa-solid fa-triangle-exclamation"></i> Failed to communicate with database server.
                    </td>
                </tr>`;
        }
    }

    function renderLogs(logs) {
        if (!logs || logs.length === 0) {
            logsTableBody.innerHTML = `
                <tr>
                    <td colspan="5" class="table-loading">
                        <i class="fa-solid fa-box-open"></i> No attendance logging matches found.
                    </td>
                </tr>`;
            return;
        }

        let html = "";
        logs.forEach(log => {
            const isCheckin = log.status === "Checked-in";
            const badgeClass = isCheckin ? "checked-in" : "checked-out";
            const confidenceVal = log.confidence ? parseFloat(log.confidence) : null;
            const confidenceStr = confidenceVal ? `${(100 - confidenceVal).toFixed(1)}% Match` : "--";
            
            // Format time and date
            const dt = log.timestamp.split(" ");
            const dateStr = dt[0];
            const timeStr = dt[1] ? dt[1] : "";
            
            // Snapshot check-in verification trigger
            let snapshotCell = '<span style="color:var(--text-muted)">--</span>';
            if (isCheckin) {
                // Filename structure: logs/snapshots/Name/YYYY-MM-DD_HH-MM-SS.jpg
                const cleanTimestamp = log.timestamp.replace(" ", "_").replace(/:/g, "-");
                const snapshotPath = `/snapshots/${encodeURIComponent(log.name)}/${cleanTimestamp}.jpg`;
                
                snapshotCell = `
                    <div class="snapshot-thumbnail-container" onclick="openSnapshotModal('${log.name}', '${log.timestamp}', '${snapshotPath}')">
                        <img src="${snapshotPath}" alt="Thumb" class="snapshot-thumb" onerror="this.src='https://placehold.co/100x100/100e17/00f5ff?text=No+Img'">
                        <div class="snapshot-hover-badge">
                            <i class="fa-solid fa-eye"></i>
                        </div>
                    </div>`;
            }

            html += `
                <tr>
                    <td><strong>${dateStr}</strong> <span style="color:var(--text-muted);margin-left:5px;">${timeStr}</span></td>
                    <td><strong>${log.name}</strong></td>
                    <td><span class="badge-status ${badgeClass}">${log.status}</span></td>
                    <td>${confidenceStr}</td>
                    <td>${snapshotCell}</td>
                </tr>`;
        });

        logsTableBody.innerHTML = html;
    }

    function filterLogs() {
        const query = logSearchInput.value.toLowerCase().trim();
        const status = logStatusFilter.value;

        const filtered = cachedLogs.filter(log => {
            const matchesSearch = log.name.toLowerCase().includes(query);
            const matchesStatus = (status === "all") || (log.status === status);
            return matchesSearch && matchesStatus;
        });

        renderLogs(filtered);
    }

    // Modal Control: Snapshots Display
    const snapshotModal = document.getElementById("snapshot-modal");
    const modalSnapshotImg = document.getElementById("modal-snapshot-img");
    const modalSnapshotName = document.getElementById("modal-snapshot-name");
    const modalSnapshotTime = document.getElementById("modal-snapshot-time");

    window.openSnapshotModal = function(name, timestamp, path) {
        modalSnapshotImg.src = path;
        modalSnapshotName.innerText = name;
        modalSnapshotTime.innerText = timestamp;
        snapshotModal.classList.add("active");
    };

    document.getElementById("btn-close-modal").addEventListener("click", () => {
        snapshotModal.classList.remove("active");
    });
    
    // Close modal on click outside content card
    snapshotModal.addEventListener("click", (e) => {
        if (e.target === snapshotModal) {
            snapshotModal.classList.remove("active");
        }
    });

    // 8. Manage Members Database view
    const membersListGrid = document.getElementById("members-list-grid");
    document.getElementById("btn-refresh-members").addEventListener("click", fetchMembers);

    async function fetchMembers() {
        membersListGrid.innerHTML = `
            <div class="empty-state">
                <i class="fa-solid fa-spinner fa-spin"></i>
                <p>Scanning biometric directory...</p>
            </div>`;
            
        try {
            const res = await fetch("/api/members");
            const members = await res.json();
            renderMembers(members);
        } catch (e) {
            console.error("Error fetching members database:", e);
            membersListGrid.innerHTML = `
                <div class="empty-state" style="color:var(--danger)">
                    <i class="fa-solid fa-circle-exclamation"></i>
                    <p>Failed to load biometric database.</p>
                </div>`;
        }
    }

    function renderMembers(members) {
        if (!members || members.length === 0) {
            membersListGrid.innerHTML = `
                <div class="empty-state">
                    <i class="fa-solid fa-users-slash"></i>
                    <p>No facial biometrics database found. Please enroll faces first!</p>
                </div>`;
            return;
        }

        membersListGrid.innerHTML = "";
        members.forEach(member => {
            const card = document.createElement("div");
            card.className = "member-card";
            card.innerHTML = `
                <div class="member-avatar">
                    <i class="fa-solid fa-user"></i>
                </div>
                <h3>${member.name}</h3>
                <p>${member.image_count} Samples</p>
                <div style="display:flex; gap:5px; margin-top:10px;">
                    <button class="action-btn-secondary btn-inspect-member" data-name="${member.name}" style="flex:1; padding:8px; font-size:0.8rem;">
                        <i class="fa-solid fa-eye"></i> Inspect
                    </button>
                    <button class="action-btn-danger btn-delete-member" data-name="${member.name}" style="flex:1; padding:8px; font-size:0.8rem;">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            `;
            membersListGrid.appendChild(card);
        });
        
        // Add event listeners to inspect buttons
        document.querySelectorAll(".btn-inspect-member").forEach(btn => {
            btn.addEventListener("click", async (e) => {
                const name = e.currentTarget.getAttribute("data-name");
                openProfileModal(name);
            });
        });
        
        // Add event listeners to delete buttons
        document.querySelectorAll(".btn-delete-member").forEach(btn => {
            btn.addEventListener("click", async (e) => {
                const name = e.currentTarget.getAttribute("data-name");
                deleteMember(name);
            });
        });
    }

    window.deleteMember = async function(name) {
        if (confirm(`CRITICAL: Wipe all biometric datasets for '${name}'? This will permanently erase their files and retrain the face recognition AI.`)) {
            showLoadingOverlay("Deleting biometric profile", `Removing files and re-routing facial vector structures for '${name}'...`);
            try {
                const res = await fetch(`/api/members/${encodeURIComponent(name)}`, {
                    method: "DELETE"
                });
                const status = await res.json();
                
                if (status.success) {
                    // Check-out status reload
                    pollTrainingStatus();
                } else {
                    alert(status.message);
                    hideLoadingOverlay();
                }
            } catch (e) {
                console.error("Error deleting member:", e);
                hideLoadingOverlay();
            }
        }
    };
});
