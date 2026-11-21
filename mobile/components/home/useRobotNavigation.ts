import React, { useState, useEffect } from 'react';
import type { Coord, RobotStatus } from './types';
import { distanceMeters } from './navigation';
import { Socket } from 'socket.io-client';

type RobotNavigationOptions = {
  robotStatus: RobotStatus | null;
  peerCoord: Coord | null;
  pairCodeRef: React.RefObject<string>;
  socketRef: React.RefObject<Socket | null>;
  setNavActive: React.Dispatch<React.SetStateAction<boolean>>;
  navActive: boolean;
};

export function useRobotNavigation({
  robotStatus,
  peerCoord,
  pairCodeRef,
  socketRef,
  setNavActive,
  navActive,
}: RobotNavigationOptions) {
  // Destination / navigation (carte)
  const [destInput, setDestInput] = useState('');

  const [destSuggestions, setDestSuggestions] = useState<
    { label: string; latitude: number; longitude: number }[]
  >([]);
  const [destination, setDestination] = useState<
    { latitude: number; longitude: number; label: string } | null
  >(null);
  const [destStartDist, setDestStartDist] = useState<number | null>(null);
  const [routeCoords, setRouteCoords] = useState<Coord[]>([]);

  // Position du robot (priorite au statut robot, sinon derniere position recue).
  const robotCoord: Coord | null =
    robotStatus?.coords &&
    typeof robotStatus.coords.latitude === 'number' &&
    typeof robotStatus.coords.longitude === 'number'
      ? { latitude: robotStatus.coords.latitude, longitude: robotStatus.coords.longitude }
      : peerCoord;
  const robotRegion = robotCoord
    ? {
        latitude: robotCoord.latitude,
        longitude: robotCoord.longitude,
        latitudeDelta: 0.0015,
        longitudeDelta: 0.0015,
      }
    : undefined;

  // Suggestions d'adresse (OpenStreetMap / Nominatim) pendant la saisie.
  useEffect(() => {
    const q = destInput.trim();
    if (q.length < 3 || destination) {
      setDestSuggestions([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&accept-language=fr&q=${encodeURIComponent(q)}`;
        const res = await fetch(url, { headers: { Accept: 'application/json' } });
        const data = await res.json();
        if (Array.isArray(data)) {
          setDestSuggestions(
            data
              .map((d: any) => ({
                label: String(d.display_name || ''),
                latitude: parseFloat(d.lat),
                longitude: parseFloat(d.lon),
              }))
              .filter((s) => Number.isFinite(s.latitude) && Number.isFinite(s.longitude))
          );
        }
      } catch {}
    }, 500);
    return () => clearTimeout(t);
  }, [destInput, destination]);

  // Distance de depart, figee une fois la destination posee (base du %).
  useEffect(() => {
    if (destination && robotCoord && destStartDist == null) {
      const d = distanceMeters(robotCoord, destination);
      if (d != null) setDestStartDist(d);
    }
  }, [destination, robotCoord, destStartDist]);

  // Itineraire (route qui suit les rues, via OSRM) recalcule quand la
  // destination change. Repli en ligne droite si le service repond mal.
  useEffect(() => {
    let cancelled = false;
    if (!destination) {
      setRouteCoords([]);
      return;
    }
    const from = robotCoord; // position du robot au moment ou on pose la destination
    if (!from) {
      setRouteCoords([]);
      return;
    }
    const straight = [
      { latitude: from.latitude, longitude: from.longitude },
      { latitude: destination.latitude, longitude: destination.longitude },
    ];
    (async () => {
      try {
        const url = `https://router.project-osrm.org/route/v1/driving/${from.longitude},${from.latitude};${destination.longitude},${destination.latitude}?overview=full&geometries=geojson`;
        const res = await fetch(url);
        const data = await res.json();
        const coords = data?.routes?.[0]?.geometry?.coordinates;
        if (cancelled) return;
        if (Array.isArray(coords) && coords.length > 1) {
          setRouteCoords(
            coords.map((c: number[]) => ({ latitude: c[1], longitude: c[0] }))
          );
        } else {
          setRouteCoords(straight);
        }
      } catch {
        if (!cancelled) setRouteCoords(straight);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [destination]);

  const selectDestination = (s: { label: string; latitude: number; longitude: number }) => {
    setDestination({ latitude: s.latitude, longitude: s.longitude, label: s.label });
    setDestInput(s.label);
    setDestSuggestions([]);
    setDestStartDist(robotCoord ? distanceMeters(robotCoord, s) : null);
  };


  const startNav = () => {
    const code = pairCodeRef.current?.trim();
    if (!socketRef.current || !code || !destination) return;
    socketRef.current.emit('robot_nav', {
      code,
      target: { latitude: destination.latitude, longitude: destination.longitude },
      on: true,
    });
    setNavActive(true);
  };

  const stopNav = () => {
    const code = pairCodeRef.current?.trim();
    if (code) socketRef.current?.emit('robot_nav', { code, on: false });
    setNavActive(false);
  };

  const clearDestination = () => {
    if (navActive) stopNav();
    setDestination(null);
    setDestStartDist(null);
    setDestInput('');
    setDestSuggestions([]);
  };

  const remainingDist =
    destination && robotCoord ? distanceMeters(robotCoord, destination) : null;
  const progressPct =
    destStartDist && destStartDist > 0 && remainingDist != null
      ? Math.max(0, Math.min(100, Math.round((1 - remainingDist / destStartDist) * 100)))
      : 0;

  return {
    robotCoord,
    robotRegion,
    destInput,
    setDestInput,
    destSuggestions,
    setDestSuggestions,
    destination,
    setDestination,
    setDestStartDist,
    routeCoords,
    selectDestination,
    startNav,
    stopNav,
    clearDestination,
    remainingDist,
    progressPct,
  };
}
