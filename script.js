/**
 * Personal Website Weather Integration
 * Uses Open-Meteo API (free, no key needed) for weather
 * Uses ip-api.com for IP-based geolocation fallback
 */

// WMO Weather interpretation codes mapping
const WEATHER_CODES = {
    0: { type: 'clear', icon: '☀️', description: 'Helder' },
    1: { type: 'partly-cloudy', icon: '🌤️', description: 'Licht bewolkt' },
    2: { type: 'partly-cloudy', icon: '⛅', description: 'Gedeeltelijk bewolkt' },
    3: { type: 'cloudy', icon: '☁️', description: 'Bewolkt' },
    45: { type: 'fog', icon: '🌫️', description: 'Mist' },
    48: { type: 'fog', icon: '🌫️', description: 'Rijpmist' },
    51: { type: 'rain', icon: '🌧️', description: 'Lichte motregen' },
    53: { type: 'rain', icon: '🌧️', description: 'Motregen' },
    55: { type: 'rain', icon: '🌧️', description: 'Zware motregen' },
    56: { type: 'rain', icon: '🌧️', description: 'Ijzige motregen' },
    57: { type: 'rain', icon: '🌧️', description: 'Zware ijzige motregen' },
    61: { type: 'rain', icon: '🌧️', description: 'Lichte regen' },
    63: { type: 'rain', icon: '🌧️', description: 'Regen' },
    65: { type: 'rain', icon: '🌧️', description: 'Zware regen' },
    66: { type: 'rain', icon: '🌧️', description: 'IJzige regen' },
    67: { type: 'rain', icon: '🌧️', description: 'Zware ijzige regen' },
    71: { type: 'snow', icon: '🌨️', description: 'Lichte sneeuw' },
    73: { type: 'snow', icon: '🌨️', description: 'Sneeuw' },
    75: { type: 'snow', icon: '❄️', description: 'Zware sneeuw' },
    77: { type: 'snow', icon: '🌨️', description: 'Sneeuwkorrels' },
    80: { type: 'showers', icon: '🌦️', description: 'Lichte buien' },
    81: { type: 'showers', icon: '🌦️', description: 'Buien' },
    82: { type: 'showers', icon: '⛈️', description: 'Zware buien' },
    85: { type: 'snow', icon: '🌨️', description: 'Lichte sneeuwbuien' },
    86: { type: 'snow', icon: '❄️', description: 'Zware sneeuwbuien' },
    95: { type: 'thunderstorm', icon: '⛈️', description: 'Onweer' },
    96: { type: 'thunderstorm', icon: '⛈️', description: 'Onweer met hagel' },
    99: { type: 'thunderstorm', icon: '⛈️', description: 'Zwaar onweer met hagel' }
};

// State
let currentWeatherType = 'clear';
let particleInterval = null;
let lightningInterval = null;

// DOM Elements
const body = document.body;
const particlesContainer = document.getElementById('particles');
const weatherIcon = document.getElementById('weather-icon');
const weatherTemp = document.getElementById('weather-temp');
const weatherLocation = document.getElementById('weather-location');
const locationPrompt = document.getElementById('location-prompt');
const allowLocationBtn = document.getElementById('allow-location');
const denyLocationBtn = document.getElementById('deny-location');

/**
 * Initialize the weather system
 */
function init() {
    // Check if we've already asked for location
    const locationPreference = localStorage.getItem('locationPreference');

    if (locationPreference === 'allowed') {
        requestGPSLocation();
    } else if (locationPreference === 'denied') {
        useIPGeolocation();
    } else {
        // Show the prompt
        showLocationPrompt();
    }

    // Set up button handlers
    allowLocationBtn.addEventListener('click', () => {
        localStorage.setItem('locationPreference', 'allowed');
        hideLocationPrompt();
        requestGPSLocation();
    });

    denyLocationBtn.addEventListener('click', () => {
        localStorage.setItem('locationPreference', 'denied');
        hideLocationPrompt();
        useIPGeolocation();
    });

    // Refresh weather every 30 minutes
    setInterval(() => {
        const pref = localStorage.getItem('locationPreference');
        if (pref === 'allowed') {
            requestGPSLocation();
        } else {
            useIPGeolocation();
        }
    }, 30 * 60 * 1000);
}

/**
 * Show location permission prompt
 */
function showLocationPrompt() {
    locationPrompt.classList.remove('hidden');
}

/**
 * Hide location permission prompt
 */
function hideLocationPrompt() {
    locationPrompt.classList.add('hidden');
}

/**
 * Request GPS location from browser
 */
function requestGPSLocation() {
    if ('geolocation' in navigator) {
        weatherLocation.textContent = 'Locatie ophalen...';

        navigator.geolocation.getCurrentPosition(
            (position) => {
                const { latitude, longitude } = position.coords;
                console.log('GPS location obtained:', latitude, longitude);
                fetchWeather(latitude, longitude);
                reverseGeocode(latitude, longitude);
            },
            (error) => {
                console.warn('GPS location failed:', error.message);
                // Fall back to IP geolocation
                useIPGeolocation();
            },
            {
                enableHighAccuracy: false,
                timeout: 10000,
                maximumAge: 600000 // Cache for 10 minutes
            }
        );
    } else {
        console.warn('Geolocation not supported');
        useIPGeolocation();
    }
}

/**
 * Use IP-based geolocation as fallback
 */
async function useIPGeolocation() {
    weatherLocation.textContent = 'Locatie bepalen...';

    try {
        const response = await fetch('http://ip-api.com/json/?lang=nl');
        const data = await response.json();

        if (data.status === 'success') {
            console.log('IP geolocation obtained:', data.city, data.country);
            weatherLocation.textContent = data.city || data.regionName || data.country;
            fetchWeather(data.lat, data.lon);
        } else {
            throw new Error('IP geolocation failed');
        }
    } catch (error) {
        console.error('IP geolocation error:', error);
        weatherLocation.textContent = 'Locatie onbekend';
        // Default to Amsterdam
        fetchWeather(52.3676, 4.9041);
    }
}

/**
 * Reverse geocode coordinates to get city name
 */
async function reverseGeocode(lat, lon) {
    try {
        // Use Open-Meteo's geocoding for reverse lookup via a simple method
        const response = await fetch(`http://ip-api.com/json/?lang=nl`);
        const data = await response.json();

        if (data.status === 'success') {
            weatherLocation.textContent = data.city || data.regionName || 'Nederland';
        }
    } catch (error) {
        console.log('Reverse geocode failed, using coordinates');
        weatherLocation.textContent = `${lat.toFixed(1)}°, ${lon.toFixed(1)}°`;
    }
}

/**
 * Fetch weather data from Open-Meteo API
 */
async function fetchWeather(lat, lon) {
    try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&timezone=auto`;

        const response = await fetch(url);
        const data = await response.json();

        if (data.current) {
            const temp = Math.round(data.current.temperature_2m);
            const weatherCode = data.current.weather_code;

            console.log('Weather data:', { temp, weatherCode });

            updateWeatherDisplay(temp, weatherCode);
            updateBackground(weatherCode);
        }
    } catch (error) {
        console.error('Weather fetch error:', error);
        weatherTemp.textContent = '--°C';
    }
}

/**
 * Update the weather indicator display
 */
function updateWeatherDisplay(temp, code) {
    const weather = WEATHER_CODES[code] || WEATHER_CODES[0];

    weatherIcon.textContent = weather.icon;
    weatherTemp.textContent = `${temp}°C`;
    weatherTemp.title = weather.description;
}

/**
 * Update background based on weather code
 */
function updateBackground(code) {
    const weather = WEATHER_CODES[code] || WEATHER_CODES[0];
    const newType = weather.type;

    // Remove old weather class
    body.className = '';

    // Add new weather class
    body.classList.add(`weather-${newType}`);

    // Update particles
    if (newType !== currentWeatherType) {
        currentWeatherType = newType;
        updateParticles(newType);
    }
}

/**
 * Update particle effects based on weather type
 */
function updateParticles(weatherType) {
    // Clear existing particles
    particlesContainer.innerHTML = '';

    // Clear intervals
    if (particleInterval) clearInterval(particleInterval);
    if (lightningInterval) clearInterval(lightningInterval);

    switch (weatherType) {
        case 'clear':
            createSunRays();
            break;
        case 'partly-cloudy':
            createClouds(3);
            createSunRays();
            break;
        case 'cloudy':
            createClouds(6);
            break;
        case 'fog':
            createFog();
            break;
        case 'rain':
        case 'showers':
            createRain(50);
            break;
        case 'snow':
            createSnow(40);
            break;
        case 'thunderstorm':
            createRain(70);
            createLightning();
            break;
    }
}

/**
 * Create sun rays effect
 */
function createSunRays() {
    const sun = document.createElement('div');
    sun.className = 'sun-rays';
    particlesContainer.appendChild(sun);
}

/**
 * Create cloud effects
 */
function createClouds(count) {
    for (let i = 0; i < count; i++) {
        const cloud = document.createElement('div');
        cloud.className = 'cloud';
        cloud.style.top = `${Math.random() * 40}%`;
        cloud.style.animationDuration = `${30 + Math.random() * 30}s`;
        cloud.style.animationDelay = `${-Math.random() * 30}s`;
        cloud.style.opacity = 0.3 + Math.random() * 0.4;
        particlesContainer.appendChild(cloud);
    }
}

/**
 * Create fog effect
 */
function createFog() {
    for (let i = 0; i < 5; i++) {
        const fog = document.createElement('div');
        fog.className = 'cloud';
        fog.style.top = `${20 + i * 15}%`;
        fog.style.width = '400px';
        fog.style.height = '150px';
        fog.style.animationDuration = `${60 + Math.random() * 40}s`;
        fog.style.animationDelay = `${-Math.random() * 60}s`;
        fog.style.opacity = 0.5;
        particlesContainer.appendChild(fog);
    }
}

/**
 * Create rain effect
 */
function createRain(intensity) {
    function addRainDrops() {
        for (let i = 0; i < intensity / 5; i++) {
            const drop = document.createElement('div');
            drop.className = 'rain-drop';
            drop.style.left = `${Math.random() * 100}%`;
            drop.style.animationDuration = `${0.5 + Math.random() * 0.5}s`;
            drop.style.animationDelay = `${Math.random() * 0.5}s`;
            particlesContainer.appendChild(drop);

            // Remove after animation
            setTimeout(() => drop.remove(), 2000);
        }
    }

    addRainDrops();
    particleInterval = setInterval(addRainDrops, 200);
}

/**
 * Create snow effect
 */
function createSnow(intensity) {
    function addSnowflakes() {
        for (let i = 0; i < intensity / 10; i++) {
            const flake = document.createElement('div');
            flake.className = 'snowflake';
            flake.style.left = `${Math.random() * 100}%`;
            flake.style.width = `${4 + Math.random() * 8}px`;
            flake.style.height = flake.style.width;
            flake.style.animationDuration = `${3 + Math.random() * 4}s`;
            flake.style.animationDelay = `${Math.random() * 2}s`;
            particlesContainer.appendChild(flake);

            // Remove after animation
            setTimeout(() => flake.remove(), 8000);
        }
    }

    addSnowflakes();
    particleInterval = setInterval(addSnowflakes, 500);
}

/**
 * Create lightning effect
 */
function createLightning() {
    const lightning = document.createElement('div');
    lightning.className = 'lightning';
    particlesContainer.appendChild(lightning);

    function flash() {
        lightning.classList.add('flash');
        setTimeout(() => lightning.classList.remove('flash'), 300);
    }

    // Random lightning flashes
    lightningInterval = setInterval(() => {
        if (Math.random() > 0.7) {
            flash();
        }
    }, 2000);
}

/**
 * Initialize and update the digital clock
 */
function initClock() {
    const clockTime = document.getElementById('clock-time');
    const clockIcon = document.getElementById('clock-icon');

    function updateClock() {
        const now = new Date();
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        clockTime.textContent = `${hours}:${minutes}`;

        // Update clock icon based on hour
        const hour = now.getHours();
        if (hour >= 6 && hour < 12) {
            clockIcon.textContent = '🕘'; // Morning
        } else if (hour >= 12 && hour < 18) {
            clockIcon.textContent = '🕐'; // Afternoon
        } else if (hour >= 18 && hour < 22) {
            clockIcon.textContent = '🕕'; // Evening
        } else {
            clockIcon.textContent = '🌙'; // Night
        }
    }

    updateClock();
    setInterval(updateClock, 1000);
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    init();
    initClock();
});
