// =============================================================================
// SPA (Solar Position Algorithm) -- JavaScript port of spa_python.py.
// Reference: Reda & Andreas, Solar Energy 76(5):577-589, 2004.
//
// This file implements SPA_ZA_INC mode (zenith, azimuth, and incidence on a
// specified surface). It does NOT compute sunrise/sunset or equation of time;
// the tracker pipeline does not need them.
//
// Numeric tables are in spa_tables.js (auto-generated from the Python source
// to guarantee bit-identical values).
//
// Validated against Reda & Andreas reference case:
//   year=2003 month=10 day=17 hour=12 minute=30 second=30 tz=-7
//   lon=-105.1786 lat=39.742476 elev=1830.14 P=820 T=11 dT=67
//   slope=30 azm_rotation=-10 atmos_refract=0.5667
// Expected:  zenith=50.111622   azimuth=194.340241   incidence=25.187000
// =============================================================================
'use strict';

const SUN_RADIUS = 0.26667;

// ---- low-level helpers ------------------------------------------------------

function _trunc(x) { return (x < 0) ? Math.ceil(x) : Math.floor(x); }  // C cast-to-int

function _limitDeg(x) {
    let r = 360.0 * (x / 360.0 - Math.floor(x / 360.0));
    if (r < 0.0) r += 360.0;
    return r;
}

function _limitDeg180pm(x) {
    let r = 360.0 * (x / 360.0 - Math.floor(x / 360.0));
    if (r < -180.0) r += 360.0;
    else if (r > 180.0) r -= 360.0;
    return r;
}

function _thirdOrder(a, b, c, d, x) {
    return ((a * x + b) * x + c) * x + d;
}

const _DEG = Math.PI / 180.0;
const _RAD = 180.0 / Math.PI;
function _r(x) { return x * _DEG; }
function _d(x) { return x * _RAD; }

// ---- validation -------------------------------------------------------------

function validateInputs(p) {
    if (p.year < -2000 || p.year > 6000) return 1;
    if (p.month < 1 || p.month > 12) return 2;
    if (p.day < 1 || p.day > 31) return 3;
    if (p.hour < 0 || p.hour > 24) return 4;
    if (p.minute < 0 || p.minute > 59) return 5;
    if (p.second < 0 || p.second >= 60) return 6;
    if (p.pressure < 0 || p.pressure > 5000) return 12;
    if (p.temperature <= -273 || p.temperature > 6000) return 13;
    if (p.delta_ut1 <= -1 || p.delta_ut1 >= 1) return 17;
    if (Math.abs(p.delta_t) > 8000) return 7;
    if (Math.abs(p.timezone) > 18) return 8;
    if (Math.abs(p.longitude) > 180) return 9;
    if (Math.abs(p.latitude) > 90) return 10;
    if (Math.abs(p.atmos_refract) > 5) return 16;
    if (p.elevation < -6500000) return 11;
    if (Math.abs(p.slope) > 360) return 14;
    if (Math.abs(p.azm_rotation) > 360) return 15;
    return 0;
}

// ---- julian day -------------------------------------------------------------

function julianDay(year, month, day, hour, minute, second, dut1, tz) {
    const dayDec = day + (hour - tz + (minute + (second + dut1) / 60.0) / 60.0) / 24.0;
    if (month < 3) { month += 12; year -= 1; }
    let jd = _trunc(365.25 * (year + 4716.0)) + _trunc(30.6001 * (month + 1)) + dayDec - 1524.5;
    if (jd > 2299160.0) {
        const a = _trunc(year / 100);
        jd += 2 - a + _trunc(a / 4);
    }
    return jd;
}

// ---- earth periodic terms ---------------------------------------------------

function _earthSum(terms, jme) {
    let s = 0.0;
    for (let i = 0; i < terms.length; i++) {
        s += terms[i][0] * Math.cos(terms[i][1] + terms[i][2] * jme);
    }
    return s;
}

function _earthCombine(termSums, jme) {
    let total = 0.0;
    for (let i = 0; i < termSums.length; i++) {
        total += termSums[i] * Math.pow(jme, i);
    }
    return total / 1.0e8;
}

function earthHelioLongitude(jme) {
    const sums = L_TERMS.map((t, i) => _earthSum(t.slice(0, L_SUBCOUNT[i]), jme));
    return _limitDeg(_d(_earthCombine(sums, jme)));
}

function earthHelioLatitude(jme) {
    const sums = B_TERMS.map((t, i) => _earthSum(t.slice(0, B_SUBCOUNT[i]), jme));
    return _d(_earthCombine(sums, jme));
}

function earthRadiusVector(jme) {
    const sums = R_TERMS.map((t, i) => _earthSum(t.slice(0, R_SUBCOUNT[i]), jme));
    return _earthCombine(sums, jme);
}

// ---- nutation & obliquity ---------------------------------------------------

function _nutation(jce, x) {
    let sumPsi = 0.0, sumEps = 0.0;
    for (let i = 0; i < 63; i++) {
        let xy = 0.0;
        for (let j = 0; j < 5; j++) xy += x[j] * Y_TERMS[i][j];
        xy = _r(xy);
        sumPsi += (PE_TERMS[i][0] + jce * PE_TERMS[i][1]) * Math.sin(xy);
        sumEps += (PE_TERMS[i][2] + jce * PE_TERMS[i][3]) * Math.cos(xy);
    }
    return [sumPsi / 36000000.0, sumEps / 36000000.0];
}

function eclipticMeanObliquity(jme) {
    const u = jme / 10.0;
    return 84381.448 + u * (-4680.93 + u * (-1.55 + u * (1999.25 + u * (-51.38 + u * (-249.67 +
        u * (-39.05 + u * (7.12 + u * (27.87 + u * (5.79 + u * 2.45)))))))));
}

// ---- main calculation -------------------------------------------------------

/**
 * Compute solar position (zenith, azimuth) and surface incidence.
 *
 * @param {Object} p  All SPA inputs as named fields.
 * @returns {Object}  {err, zenith, azimuth, elevation, elevation0, incidence}
 *   err = 0 on success; non-zero = validation error code from validateInputs.
 */
function spaCalculate(p) {
    const err = validateInputs(p);
    if (err !== 0) return { err };

    const jd = julianDay(p.year, p.month, p.day, p.hour, p.minute, p.second, p.delta_ut1, p.timezone);
    const jc = (jd - 2451545.0) / 36525.0;
    const jde = jd + p.delta_t / 86400.0;
    const jce = (jde - 2451545.0) / 36525.0;
    const jme = jce / 10.0;

    const L = earthHelioLongitude(jme);
    const B = earthHelioLatitude(jme);
    const R = earthRadiusVector(jme);
    let theta = L + 180.0; if (theta >= 360.0) theta -= 360.0;
    const beta = -B;

    const x = [
        _thirdOrder(1.0/189474.0, -0.0019142, 445267.11148, 297.85036, jce),
        _thirdOrder(-1.0/300000.0, -0.0001603, 35999.05034, 357.52772, jce),
        _thirdOrder(1.0/56250.0, 0.0086972, 477198.867398, 134.96298, jce),
        _thirdOrder(1.0/327270.0, -0.0036825, 483202.017538, 93.27191, jce),
        _thirdOrder(1.0/450000.0, 0.0020708, -1934.136261, 125.04452, jce),
    ];
    const [delPsi, delEps] = _nutation(jce, x);
    const eps0 = eclipticMeanObliquity(jme);
    const epsilon = delEps + eps0 / 3600.0;
    const delTau = -20.4898 / (3600.0 * R);
    const lamda = theta + delPsi + delTau;

    const nu0 = _limitDeg(280.46061837 + 360.98564736629 * (jd - 2451545.0) +
                          jc * jc * (0.000387933 - jc / 38710000.0));
    const nu = nu0 + delPsi * Math.cos(_r(epsilon));

    // geocentric right ascension & declination
    const lamRad = _r(lamda);
    const epsRad = _r(epsilon);
    const alpha = _limitDeg(_d(Math.atan2(
        Math.sin(lamRad) * Math.cos(epsRad) - Math.tan(_r(beta)) * Math.sin(epsRad),
        Math.cos(lamRad)
    )));
    const delta = _d(Math.asin(
        Math.sin(_r(beta)) * Math.cos(epsRad) +
        Math.cos(_r(beta)) * Math.sin(epsRad) * Math.sin(lamRad)
    ));

    // observer hour angle
    const H = _limitDeg(nu + p.longitude - alpha);

    // parallax and topocentric declination
    const xi = 8.794 / (3600.0 * R);
    const latRad = _r(p.latitude);
    const xiRad = _r(xi);
    const Hrad = _r(H);
    const dRad = _r(delta);
    const u = Math.atan(0.99664719 * Math.tan(latRad));
    const yy = 0.99664719 * Math.sin(u) + p.elevation * Math.sin(latRad) / 6378140.0;
    const xx = Math.cos(u) + p.elevation * Math.cos(latRad) / 6378140.0;
    const delAlphaRad = Math.atan2(
        -xx * Math.sin(xiRad) * Math.sin(Hrad),
        Math.cos(dRad) - xx * Math.sin(xiRad) * Math.cos(Hrad)
    );
    const deltaPrime = _d(Math.atan2(
        (Math.sin(dRad) - yy * Math.sin(xiRad)) * Math.cos(delAlphaRad),
        Math.cos(dRad) - xx * Math.sin(xiRad) * Math.cos(Hrad)
    ));
    const Hprime = H - _d(delAlphaRad);

    // topocentric elevation, azimuth
    const HpRad = _r(Hprime);
    const dpRad = _r(deltaPrime);
    const e0 = _d(Math.asin(
        Math.sin(latRad) * Math.sin(dpRad) +
        Math.cos(latRad) * Math.cos(dpRad) * Math.cos(HpRad)
    ));
    let delE = 0.0;
    if (e0 >= -1.0 * (SUN_RADIUS + p.atmos_refract)) {
        delE = (p.pressure / 1010.0) * (283.0 / (273.0 + p.temperature)) *
               1.02 / (60.0 * Math.tan(_r(e0 + 10.3 / (e0 + 5.11))));
    }
    const e = e0 + delE;
    const zenith = 90.0 - e;

    const azimuthAstro = _limitDeg(_d(Math.atan2(
        Math.sin(HpRad),
        Math.cos(HpRad) * Math.sin(latRad) - Math.tan(dpRad) * Math.cos(latRad)
    )));
    const azimuth = _limitDeg(azimuthAstro + 180.0);

    // surface incidence
    const zRad = _r(zenith);
    const slopeRad = _r(p.slope);
    const cosTheta = Math.cos(zRad) * Math.cos(slopeRad) +
                     Math.sin(slopeRad) * Math.sin(zRad) *
                     Math.cos(_r(azimuthAstro - p.azm_rotation));
    const incidence = _d(Math.acos(Math.max(-1.0, Math.min(1.0, cosTheta))));

    return {
        err: 0,
        zenith,
        azimuth,
        elevation: e,
        elevation0: e0,
        incidence,
    };
}

// ---- public API -------------------------------------------------------------
// Defaults match SPADATA defaults in spa_python.py.
function makeSpaInput(overrides) {
    return Object.assign({
        year: 2003, month: 10, day: 17, hour: 12, minute: 30, second: 30.0,
        timezone: -7.0, delta_ut1: 0.0, delta_t: 67.0,
        longitude: -105.1786, latitude: 39.742476, elevation: 1830.14,
        pressure: 820.0, temperature: 11.0,
        slope: 30.0, azm_rotation: -10.0, atmos_refract: 0.5667,
    }, overrides || {});
}

// Expose to global scope (the HTML loads this as a plain <script>).
window.SPA = { spaCalculate, makeSpaInput, validateInputs };
