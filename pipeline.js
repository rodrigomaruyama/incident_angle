// =============================================================================
// Tracker analysis pipeline -- JavaScript port of tracker_pipeline_spa.py.
// Operates on a SPA backend (see spa.js). Pure functions, no DOM access.
// =============================================================================
'use strict';

const D = Math.PI / 180.0;
const R = 180.0 / Math.PI;

function normalize360(a) { return ((a % 360.0) + 360.0) % 360.0; }
function normalize180(a) { return ((a + 180.0) % 360.0 + 360.0) % 360.0 - 180.0; }
function clipDeg(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Convert user-supplied axis azimuth to ENU (0=N, +E).
function convertAxisAzimuth(userDeg, convention) {
    if (convention === 'pvlib') return userDeg;
    if (convention === 'negative_east') return -userDeg;
    throw new Error("convention must be 'pvlib' or 'negative_east'");
}

// Sign convention for the measured rotation column.
function measuredToModel(meas, sign) {
    if (sign === 'positive_east') return meas;
    if (sign === 'positive_west') return -meas;
    throw new Error("sign must be 'positive_east' or 'positive_west'");
}

// Build (slope, surface azimuth from N, SPA azm_rotation) from a signed
// tracker rotation in the +E convention. Mirrors surface_geometry_for_spa
// in tracker_pipeline_spa.py.
function surfaceGeometry(rotationDeg, axisAzEnuDeg) {
    const r = rotationDeg * D;
    const g = axisAzEnuDeg * D;
    const nE = Math.cos(g) * Math.sin(r);
    const nN = -Math.sin(g) * Math.sin(r);
    const nU = Math.max(-1, Math.min(1, Math.cos(r)));
    const slope = Math.acos(nU) * R;
    let surfAzFromN;
    if (Math.abs(Math.sin(slope * D)) < 1e-12) {
        surfAzFromN = 180.0; // horizontal: azimuth irrelevant
    } else {
        surfAzFromN = normalize360(Math.atan2(nE, nN) * R);
    }
    const azmRotSpa = normalize180(surfAzFromN - 180.0);
    return { slope, surfAzFromN, azmRotSpa };
}

// Marion-Dobos optimum rotation for a horizontal-axis tracker.
function marionDobos(zenithDeg, azimuthDeg, axisAzEnuDeg) {
    const z = zenithDeg * D;
    const daz = (azimuthDeg - axisAzEnuDeg) * D;
    return Math.atan2(Math.sin(z) * Math.sin(daz), Math.cos(z)) * R;
}

// Incidence at an arbitrary rotation, using the closed-form cosine formula.
// Equivalent to spa.incidence within float precision.
function incidenceFromRotation(rotDeg, zenithDeg, azimuthDeg, axisAzEnuDeg) {
    const r = rotDeg * D;
    const z = zenithDeg * D;
    const daz = (azimuthDeg - axisAzEnuDeg) * D;
    const c = Math.cos(r) * Math.cos(z) + Math.sin(r) * Math.sin(z) * Math.sin(daz);
    return Math.acos(Math.max(-1, Math.min(1, c))) * R;
}

// Flat-ground backtracking approximation.
function backtrackingRotation(rMdDeg, gcr) {
    if (!(gcr > 0 && gcr < 1)) return rMdDeg;
    const absR = Math.abs(rMdDeg);
    const rcrit = Math.acos(gcr) * R;
    if (absR <= rcrit) return rMdDeg;
    const ratio = Math.max(-1, Math.min(1, Math.cos(absR * D) / gcr));
    const corr = Math.acos(ratio) * R;
    return rMdDeg - Math.sign(rMdDeg) * corr;
}

// -----------------------------------------------------------------------------
// Main batch processing
// -----------------------------------------------------------------------------

/**
 * Process an array of {timestamp: Date, rotationMeasured: number} samples.
 * Returns an array of result rows mirroring the Python output.
 *
 * site = {latitude, longitude, timezone, elevation, pressure, temperature,
 *         deltaT, deltaUt1, atmosRefract}
 * tracker = {axisAzimuthDeg, axisConvention, rotationSign, pitch, moduleWidth,
 *            currentLimit, mechanicalLimit}
 * onProgress(processed, total)  optional callback for UI updates
 */
function processSamples(samples, site, tracker, onProgress) {
    const axisAzEnu = convertAxisAzimuth(tracker.axisAzimuthDeg, tracker.axisConvention);
    const gcr = tracker.moduleWidth / tracker.pitch;
    const rcrit = (gcr > 0 && gcr < 1) ? Math.acos(gcr) * R : NaN;

    const out = [];
    const N = samples.length;
    const reportEvery = Math.max(1, Math.floor(N / 100));
    let nDay = 0;

    for (let i = 0; i < N; i++) {
        const s = samples[i];
        const t = s.timestamp;
        const rMeas = s.rotationMeasured;

        if (rMeas == null || !isFinite(rMeas)) {
            out.push({ timestamp: t, rotationMeasuredOriginal: rMeas,
                       rotationMeasuredModel: NaN, _skip: true });
            continue;
        }

        const rModel = measuredToModel(rMeas, tracker.rotationSign);
        const geom = surfaceGeometry(rModel, axisAzEnu);

        const spaIn = window.SPA.makeSpaInput({
            year: t.getFullYear(), month: t.getMonth() + 1, day: t.getDate(),
            hour: t.getHours(), minute: t.getMinutes(),
            second: t.getSeconds() + t.getMilliseconds() / 1000,
            timezone: site.timezone,
            delta_ut1: site.deltaUt1, delta_t: site.deltaT,
            longitude: site.longitude, latitude: site.latitude,
            elevation: site.elevation, pressure: site.pressure,
            temperature: site.temperature, atmos_refract: site.atmosRefract,
            slope: geom.slope, azm_rotation: geom.azmRotSpa,
        });
        const spaR = window.SPA.spaCalculate(spaIn);
        if (spaR.err !== 0) {
            throw new Error(`SPA validation error ${spaR.err} at sample ${i} (${t.toISOString()})`);
        }

        const zen = spaR.zenith;
        const az = spaR.azimuth;
        const sunAbove = zen < 90.0;
        if (sunAbove) nDay++;

        let rMdUnlim = NaN, rMdCurr = NaN, rMdMech = NaN, rBt = NaN, rCmd = NaN;
        let incMdUnlim = NaN, incMdCurr = NaN, incMdMech = NaN, incCmd = NaN;
        let btActive = false;
        let dRotMech = NaN, dRotCmd = NaN, dIncMech = NaN, dIncCmd = NaN;

        if (sunAbove) {
            rMdUnlim = marionDobos(zen, az, axisAzEnu);
            rMdCurr = clipDeg(rMdUnlim, -tracker.currentLimit, tracker.currentLimit);
            rMdMech = clipDeg(rMdUnlim, -tracker.mechanicalLimit, tracker.mechanicalLimit);
            rBt = backtrackingRotation(rMdUnlim, gcr);
            rCmd = clipDeg(rBt, -tracker.mechanicalLimit, tracker.mechanicalLimit);
            btActive = isFinite(rcrit) && Math.abs(rMdUnlim) > rcrit;

            incMdUnlim = incidenceFromRotation(rMdUnlim, zen, az, axisAzEnu);
            incMdCurr = incidenceFromRotation(rMdCurr, zen, az, axisAzEnu);
            incMdMech = incidenceFromRotation(rMdMech, zen, az, axisAzEnu);
            incCmd = incidenceFromRotation(rCmd, zen, az, axisAzEnu);

            dRotMech = rModel - rMdMech;
            dRotCmd = rModel - rCmd;
            dIncMech = spaR.incidence - incMdMech;
            dIncCmd = spaR.incidence - incCmd;
        }

        out.push({
            timestamp: t,
            nightSample: !sunAbove,
            rotationMeasuredOriginal: rMeas,
            rotationMeasuredModel: rModel,
            slopeReal: geom.slope,
            surfAzRealFromN: geom.surfAzFromN,
            spaAzmRotationReal: geom.azmRotSpa,
            zenith: zen,
            azimuth: az,
            elevation: spaR.elevation,
            elevation0: spaR.elevation0,
            incidenceRealSpa: spaR.incidence,
            cosIncidenceReal: sunAbove ? Math.cos(spaR.incidence * D) : NaN,
            rotationMdUnlimited: rMdUnlim,
            rotationMdLimitedCurrent: rMdCurr,
            rotationMdLimitedMech: rMdMech,
            rotationBacktracking: rBt,
            rotationCommandDynamic: rCmd,
            incidenceMdUnlimited: incMdUnlim,
            incidenceMdLimitedCurrent: incMdCurr,
            incidenceMdLimitedMech: incMdMech,
            incidenceCommandDynamic: incCmd,
            deltaRotMeasMinusMdMech: dRotMech,
            deltaRotMeasMinusCmd: dRotCmd,
            deltaIncRealMinusMdMech: dIncMech,
            deltaIncRealMinusCmd: dIncCmd,
            backtrackingActive: btActive,
        });

        if (onProgress && (i % reportEvery === 0 || i === N - 1)) {
            onProgress(i + 1, N);
        }
    }
    return { rows: out, gcr, rcrit, axisAzEnu, nDay };
}

// -----------------------------------------------------------------------------
// CSV serialization
// -----------------------------------------------------------------------------

function rowsToCsv(rows) {
    if (rows.length === 0) return '';
    const cols = [
        ['datetime_local',           r => r.timestamp.toISOString().replace('T',' ').slice(0,19)],
        ['night_sample',             r => r.nightSample ? 'True' : 'False'],
        ['measured_rotation_original_deg',  r => fmt(r.rotationMeasuredOriginal)],
        ['measured_rotation_model_deg',     r => fmt(r.rotationMeasuredModel)],
        ['slope_real_deg',                  r => fmt(r.slopeReal)],
        ['surface_azimuth_real_from_north_deg', r => fmt(r.surfAzRealFromN)],
        ['spa_azm_rotation_real_deg',       r => fmt(r.spaAzmRotationReal)],
        ['spa_zenith_deg',                  r => fmt(r.zenith)],
        ['spa_azimuth_deg',                 r => fmt(r.azimuth)],
        ['spa_elevation_corrected_deg',     r => fmt(r.elevation)],
        ['spa_elevation_uncorrected_deg',   r => fmt(r.elevation0)],
        ['sun_above_horizon',               r => (!r.nightSample) ? 'True' : 'False'],
        ['incidence_real_spa_deg',          r => fmt(r.incidenceRealSpa)],
        ['cos_incidence_real',              r => fmt(r.cosIncidenceReal)],
        ['rotation_md_unlimited_deg',       r => fmt(r.rotationMdUnlimited)],
        ['rotation_md_limited_current_deg', r => fmt(r.rotationMdLimitedCurrent)],
        ['rotation_md_limited_mechanical_deg', r => fmt(r.rotationMdLimitedMech)],
        ['rotation_backtracking_deg',       r => fmt(r.rotationBacktracking)],
        ['rotation_command_dynamic_deg',    r => fmt(r.rotationCommandDynamic)],
        ['incidence_md_unlimited_deg',      r => fmt(r.incidenceMdUnlimited)],
        ['incidence_md_limited_current_deg',r => fmt(r.incidenceMdLimitedCurrent)],
        ['incidence_md_limited_mechanical_deg', r => fmt(r.incidenceMdLimitedMech)],
        ['incidence_command_dynamic_deg',   r => fmt(r.incidenceCommandDynamic)],
        ['delta_rotation_measured_minus_md_mech_deg', r => fmt(r.deltaRotMeasMinusMdMech)],
        ['delta_rotation_measured_minus_command_deg', r => fmt(r.deltaRotMeasMinusCmd)],
        ['delta_incidence_real_minus_md_mech_deg',    r => fmt(r.deltaIncRealMinusMdMech)],
        ['delta_incidence_real_minus_command_deg',    r => fmt(r.deltaIncRealMinusCmd)],
        ['backtracking_active',             r => r.backtrackingActive ? 'True' : 'False'],
    ];
    function fmt(v) { return (v == null || !isFinite(v)) ? '' : v.toFixed(6); }

    const lines = [cols.map(c => c[0]).join(',')];
    for (const r of rows) {
        lines.push(cols.map(c => c[1](r)).join(','));
    }
    return lines.join('\n');
}

// -----------------------------------------------------------------------------
// Self-test (runs the same checks as the Python --self-test)
// -----------------------------------------------------------------------------

function selfTest() {
    const lines = [];
    function ok(label, cond, detail) {
        lines.push((cond ? '✓ ' : '✗ ') + label + (detail ? ` [${detail}]` : ''));
        return cond;
    }
    let pass = true;
    const ga = convertAxisAzimuth(-4.0, 'negative_east'); // 4

    // 1. R=0 -> horizontal
    let g = surfaceGeometry(0, ga);
    pass &= ok('R=0 produz superfície horizontal', Math.abs(g.slope) < 1e-9,
               `slope = ${g.slope.toExponential(2)}°`);

    // 2. R=+30 com eixo N-S -> normal a Leste
    g = surfaceGeometry(30, 0);
    pass &= ok('R=+30, eixo NS: normal inclinada para Leste',
               Math.abs(g.slope - 30) < 1e-9 &&
               Math.abs(g.surfAzFromN - 90) < 1e-6,
               `slope=${g.slope.toFixed(3)} azN=${g.surfAzFromN.toFixed(3)}`);

    // 3. R=-30 -> normal a Oeste
    g = surfaceGeometry(-30, 0);
    pass &= ok('R=-30, eixo NS: normal inclinada para Oeste',
               Math.abs(g.surfAzFromN - 270) < 1e-6,
               `azN=${g.surfAzFromN.toFixed(3)}`);

    // 4. Sol zenital -> R_MD = 0
    const rmd = marionDobos(0, 180, 0);
    pass &= ok('Sol no zênite ⇒ R_MD = 0', Math.abs(rmd) < 1e-9,
               `R_MD = ${rmd.toExponential(2)}`);

    // 5. SPA reference case
    const refInp = window.SPA.makeSpaInput({});
    const refOut = window.SPA.spaCalculate(refInp);
    pass &= ok('SPA reproduz Reda & Andreas (zenith 50.111622°)',
               Math.abs(refOut.zenith - 50.111622) < 1e-4,
               `Δ = ${Math.abs(refOut.zenith - 50.111622).toExponential(2)}°`);
    pass &= ok('SPA reproduz Reda & Andreas (incidence 25.187°)',
               Math.abs(refOut.incidence - 25.187) < 1e-3,
               `Δ = ${Math.abs(refOut.incidence - 25.187).toExponential(2)}°`);

    // 6. Cross-check Marion-Dobos vs SPA at noon on April 20, 2026
    const noonInp = window.SPA.makeSpaInput({
        year: 2026, month: 4, day: 20, hour: 12, minute: 0, second: 0,
        timezone: -3, delta_t: 69, longitude: -46.73, latitude: -23.5614,
        elevation: 750, pressure: 930, temperature: 20,
        slope: 0, azm_rotation: 0,
    });
    const noon = window.SPA.spaCalculate(noonInp);
    const rmd2 = marionDobos(noon.zenith, noon.azimuth, ga);
    const incCos = incidenceFromRotation(rmd2, noon.zenith, noon.azimuth, ga);
    const noonGeom = surfaceGeometry(rmd2, ga);
    const noon2 = window.SPA.spaCalculate(window.SPA.makeSpaInput({
        year: 2026, month: 4, day: 20, hour: 12, minute: 0, second: 0,
        timezone: -3, delta_t: 69, longitude: -46.73, latitude: -23.5614,
        elevation: 750, pressure: 930, temperature: 20,
        slope: noonGeom.slope, azm_rotation: noonGeom.azmRotSpa,
    }));
    pass &= ok('Marion-Dobos (cos) bate com spa.incidence',
               Math.abs(noon2.incidence - incCos) < 1e-3,
               `Δ = ${Math.abs(noon2.incidence - incCos).toExponential(2)}°`);

    return { pass: !!pass, lines };
}

window.Pipeline = {
    processSamples, rowsToCsv, selfTest,
    convertAxisAzimuth, surfaceGeometry, marionDobos,
    incidenceFromRotation, backtrackingRotation,
};
