let outputAudioSelection;

// Define variables for audio recording and playback
let mediaRecorder, recordedUrl, recordedBlob;
let recordedChunks = [];

document.addEventListener("DOMContentLoaded", function () {
    // Remove the loading screen once the content is loaded
    hideLoadingScreen();

    // Add an event listener to the input_text textarea for keypress
    var inputTextArea = document.getElementById('input_text');
    inputTextArea.addEventListener('keypress', function (event) {
        updateTextAreaLogic(event);
    });

    // Handle changes in the audio selection dropdown
    document.getElementById('audio_select').addEventListener('change', function () {
        outputAudioSelection = this.value;
    });

    // Add an event listener to the font selection dropdown for change
    var fontSelect = document.getElementById('font_select');
    fontSelect.addEventListener('change', function () {
        // Clear the input_text textarea when font selection is changed
        clearInputText();
    });
})

function showKeyboard() {
    var keyboardImage = document.getElementById('keyboard_image');
    var keyboardButton = document.getElementById('keyboard_button');

    // Toggle the visibility of the keyboard image
    if (keyboardImage.style.display === 'none' || keyboardImage.style.display === '') {
        keyboardImage.style.display = 'flex';
        keyboardButton.innerText = 'Hide Preeti layout';
    } else {
        keyboardImage.style.display = 'none';
        keyboardButton.innerText = 'View Preeti layout';
    }
}

function showLoadingScreen() {
    document.getElementById('loading_screen').style.display = 'flex';
}

function hideLoadingScreen() {
    document.getElementById('loading_screen').style.display = 'none';
}

function enableTextArea() {
    // Enable the text area when a font is selected
    document.getElementById('input_text').disabled = false;
}

function updateTextAreaLogic(event) {
    var fontType = document.getElementById('font_select').value;

    // Get the current value of the text area
    var inputTextArea = document.getElementById('input_text');
    var currentText = inputTextArea.value;

    // Get the cursor position
    var cursorPosition = inputTextArea.selectionStart;

    // Check if the pressed key is Enter
    if (event.key === "Enter") {
        // Manually trigger the synthesizeVoice function
        synthesizeVoice();

        // Prevent the default behavior of the keypress event
        event.preventDefault();
    } else {
        // Get the text before and after the cursor
        var textBeforeCursor = currentText.substring(0, cursorPosition);
        var textAfterCursor = currentText.substring(cursorPosition);

        // Apply nepalify formatting based on fontType
        if (fontType === "Unicode") {
            // Use nepalify to format the input text with romanized layout
            var formattedText = event.key;
            if(event.key === " "){
                textBeforeCursor = nepalify.format(textBeforeCursor, { layout: "romanized" });
            }
            var newText =  textBeforeCursor + formattedText + textAfterCursor;
        } else {
            // Use nepalify to format the input text with traditional layout
            var formattedText = nepalify.format(event.key, { layout: "traditional" });
            var newText = textBeforeCursor + formattedText + textAfterCursor;
        }
        

        // Set the updated text back to the text area
        inputTextArea.value = newText;

        // Move the cursor to the end of the inserted text
        inputTextArea.setSelectionRange(cursorPosition + formattedText.length, cursorPosition + formattedText.length);

        // Prevent the default behavior of the keypress event
        event.preventDefault();
    }
}

function clearInputText() {
    // Clear the input_text textarea
    document.getElementById('input_text').value = '';
}

function showAudioOptions() {
    // Get the selected option value
    var selectedOption = document.getElementById("audio_select").value;

    // Hide all audio-option divs
    var audioOptions = document.getElementsByClassName("audio-option");
    for (var i = 0; i < audioOptions.length; i++) {
        audioOptions[i].style.display = "none";
    }

    // Display the selected audio-option div
    document.getElementById(selectedOption + "_option").style.display = "block";
}

function showMaleOptions() {
    var select = document.getElementById("speaker_select");
    select.innerHTML = ""; // Clear previous options
    // Add male speakers
    var maleSpeakers = ["Aarogya Bhandari", "Aayush Man Shrestha", "Aayush Puri", "Abiral Manandhar", "Amar Dura", "Amit KC", "Anish Raj Manandhar", "BTkancha", "King Birendra", "Magne Buda", "Neetesh Jung Kunwar", "Prachanda", "Ravi Lamichhane"];
    for (var i = 0; i < maleSpeakers.length; i++) {
    var option = document.createElement("option");
    option.text = maleSpeakers[i];
    option.value = maleSpeakers[i];
    select.add(option);
    }
    document.getElementById("select_speaker_option").style.display = "block";
}

function showFemaleOptions() {
    var select = document.getElementById("speaker_select");
    select.innerHTML = ""; // Clear previous options
    
    // Add female speakers
    var femaleSpeakers = ["Anushka Shrestha", "Kristina Bhandari", "Lekhibooks", "Pradeepti Dongol", "Shrinkhala Khatiwada", "Shristi Shrestha", "Shruti"];
    for (var i = 0; i < femaleSpeakers.length; i++) {
        var option = document.createElement("option");
        option.text = femaleSpeakers[i];
        option.value = femaleSpeakers[i];
        select.add(option);
    }
    
    document.getElementById("select_speaker_option").style.display = "block";
}


function startRecording() {
    // Declare and initialize button variables
    let startRecordingButton = document.getElementById('start_recording_button');
    let stopRecordingButton = document.getElementById('stop_recording_button');
    
    recordedChunks = []; // Clear previously recorded chunks
    startRecordingButton.disabled = true;
    stopRecordingButton.disabled = false;
    navigator.mediaDevices.getUserMedia({ audio: true })
        .then(function (stream) {
            mediaRecorder = new MediaRecorder(stream);
            mediaRecorder.ondataavailable = function (event) {
                recordedChunks.push(event.data);
            };
            mediaRecorder.onstop = function () {
                startRecordingButton.disabled = false;
                stopRecordingButton.disabled = true;
                const audioBlob = new Blob(recordedChunks, { type: 'audio/webm' });
                const reader = new FileReader();
                reader.readAsArrayBuffer(audioBlob);
                reader.onloadend = function () {
                    const arrayBuffer = reader.result;
                    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
                    audioContext.decodeAudioData(arrayBuffer, function (audioBuffer) {
                        const audioData = audioBuffer.getChannelData(0); // Get mono audio data
                        const sampleRate = audioBuffer.sampleRate;
                        const wavBuffer = encodeWAV(audioData, sampleRate);
                        const wavBlob = new Blob([wavBuffer], { type: 'audio/wav' });
                        recordedUrl = URL.createObjectURL(wavBlob);
                        const audioPlayer = document.getElementById('recorded_audio_player');
                        audioPlayer.src = recordedUrl;
                    });
                };
            };
            mediaRecorder.start();
            document.getElementById('record_status').innerText = 'Recording...';
            setTimeout(stopRecording, 10000); //Stop recording after 10 seconds
        })
        .catch(function (err) {
            console.error('Error recording audio: ' + err);
        });
}

function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
        document.getElementById('record_status').innerText = 'Recording stopped';
    }
}

function encodeWAV(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);

    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(view, 36, 'data');
    view.setUint32(40, samples.length * 2, true);

    floatTo16BitPCM(view, 44, samples);

    return view;
}

function writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
}

function floatTo16BitPCM(output, offset, input) {
    for (let i = 0; i < input.length; i++, offset += 2) {
        const s = Math.max(-1, Math.min(1, input[i]));
        output.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
}

const uploadInput = document.getElementById('audio_file_upload');
let uploadedAudioData, file; // Variable to store the audio data

uploadInput.addEventListener('change', function(event) {
    file = event.target.files[0]; // Get the uploaded file
    if (file) {
        const reader = new FileReader(); // Create a new FileReader object
        // Define the onload event handler for the reader
        reader.onload = function(event) {
            // Once the file is loaded, store its content in the variable
            uploadedAudioData = event.target.result;
            console.log("Uploaded audio data stored in variable:", uploadedAudioData);
        };
        // Read the file as array buffer
        reader.readAsArrayBuffer(file);
    } else {
        console.error("No file selected.");
    }
});

// Function to encode ArrayBuffer as base64
function base64ArrayBuffer(arrayBuffer) {
    var binary = '';
    var bytes = new Uint8Array(arrayBuffer);
    var len = bytes.byteLength;
    for (var i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
}

// Function to fetch and convert audio file to ArrayBuffer
async function fetchAndConvertAudio(audioFilePath) {
    try {
        // Fetch the audio file
        const response = await fetch(audioFilePath);
        if (!response.ok) {
            throw new Error('Failed to fetch audio file');
        }
        // Convert the audio data to ArrayBuffer
        const arrayBuffer = await response.arrayBuffer();
        return arrayBuffer;
    } catch (error) {
        console.error('Error fetching and converting audio:', error);
        return null;
    }
}

function synthesizeVoice() {
    showLoadingScreen();
    var fontType = document.getElementById('font_select').value;
    var inputText = document.getElementById('input_text').value;
    var audioFilePath, audioData, audioMethod;

    console.log("outputAudioSelection:", outputAudioSelection);

    if(outputAudioSelection === 'record'){
        audioMethod = 'Record voice';
        audioFilePath = recordedUrl;
    }
    else if(outputAudioSelection === 'select_speaker'){
        audioMethod = 'Select speaker';
        var selectedSpeaker = document.getElementById('speaker_select').value;
        console.log('Selected speaker:', selectedSpeaker);
        audioFilePath =  '../static/speakers/' + selectedSpeaker + '.wav';
    }
    else if(outputAudioSelection === 'upload_speaker'){
        audioMethod = 'Upload speaker file';
        audioFilePath = URL.createObjectURL(file);
    }

    fetchAndConvertAudio(audioFilePath)
        .then(arrayBuffer => {
            if (arrayBuffer) {
                audioData = base64ArrayBuffer(arrayBuffer);
                console.log('Audio data loaded successfully:', audioData);

                // Make the backend request here
                fetch('https://lord-reso-nepali-voice-cloning.hf.space/synthesize', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        font_select: fontType,
                        input_text: inputText,
                        audio_select: audioMethod,
                        cloning_audio: audioData,
                    }),
                })
                .then(response => response.json())
                .then(data => {
                    hideLoadingScreen();
                    // Handle the response from the backend, Update the content of the output sections based on the response

                    //Remove placeholders
                    document.getElementById("umap_projection").style.height = "auto";
                    document.getElementById("speaker_embeddings").style.height = "auto";
                    document.getElementById("original_mel_spectrogram").style.height = "auto";
                    document.getElementById("cloned_mel_spectrogram").style.height = "auto";
                    document.getElementById("alignment_plot").style.height = "auto";
                    document.getElementById("original_waveform").style.height = "auto";
                    document.getElementById("cloned_waveform").style.height = "auto";

                    // Update Original Mel-Spectrogram
                    var melSpectrogramElement = document.getElementById('original_mel_spectrogram');
                    melSpectrogramElement.innerHTML = '<img src="data:image/png;base64,' + data.original_mel_spectrogram + '" alt="Mel-Spectrogram">';
                    // Update Cloned Mel-Spectrogram
                    var melSpectrogramElement = document.getElementById('cloned_mel_spectrogram');
                    melSpectrogramElement.innerHTML = '<img src="data:image/png;base64,' + data.mel_spectrogram + '" alt="Mel-Spectrogram">';
                    // Update Alignment Plot
                    var alignmentPlotElement = document.getElementById('alignment_plot');
                    alignmentPlotElement.innerHTML = '<img src="data:image/png;base64,' + data.alignment + '" alt="Alignment Plot">';


                    // Update Original Waveform
                    var waveformElement = document.getElementById('original_waveform');
                    waveformElement.innerHTML = '<img src="data:image/png;base64,' + data.original_waveform + '" alt="Waveform">';
                    // Update Cloned Waveform
                    var waveformElement = document.getElementById('cloned_waveform');
                    waveformElement.innerHTML = '<img src="data:image/png;base64,' + data.cloned_waveform + '" alt="Waveform">';


                    // Update Original Speaker embeddings heatmap
                    var speakerEmbeddingElement = document.getElementById('umap_projection');
                    speakerEmbeddingElement.innerHTML = '<img src="data:image/png;base64,' + data.original_embeddings_heatmap + '" alt="Speaker Embeddings">';
                    // Update Cloned Speaker embeddings heatmap
                    var speakerEmbeddingElement = document.getElementById('speaker_embeddings');
                    speakerEmbeddingElement.innerHTML = '<img src="data:image/png;base64,' + data.cloned_embeddings_heatmap + '" alt="Speaker Embeddings">';


                    //Update the audio players
                    var original_audio = document.getElementById('original_audio_player');
                    // Before playing the original audio, check if it's already playing
                    if (!original_audio.paused) {
                        original_audio.pause(); // Pause the audio if it's already playing
                    }
                    original_audio.src = 'data:audio/wav;base64,' + audioData;
                    original_audio.type = 'audio/wav';

                    // Use the existing audio element for cloned audio
                    var cloned_audio = document.getElementById('cloned_audio_player');
                    if (!cloned_audio.paused) {
                        cloned_audio.pause();
                    }
                    cloned_audio.src = 'data:audio/wav;base64,' + data.cloned_audio_data;
                    cloned_audio.type = 'audio/wav';

                    alert('Audio Generated');
                })
                .catch(error => {
                    hideLoadingScreen();
                    // Handle errors, if any
                    console.error('Error during fetch:', error);
                });
            } else {
                console.log('Failed to fetch and convert audio data.');
            }
        });
}
