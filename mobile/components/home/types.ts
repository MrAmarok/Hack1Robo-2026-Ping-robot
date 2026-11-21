export type NotifStatus = 'granted' | 'denied' | 'undetermined';
export type Coord = { latitude: number; longitude: number };
export type Mode = 'driving' | 'walking' | 'transit' | 'bicycling';
export type PendingRobotCommand = { id: string; label: string };

export type RobotDriveCommand = 'F' | 'B' | 'L' | 'R' | 'S' | '+' | '-';
export type RobotStatus = {
  fix?: boolean;
  coords?: Coord | null;
  gpsAgeMs?: number | null;
  heading?: number | null;
  speedKnots?: number | null;
  obstacleCm?: number | null;
  modeAbsent?: boolean;
  arduinoConnected?: boolean;
  navActive?: boolean;
  sharing?: boolean;
  by?: string;
  error?: string;
  ts?: number;
};

// Une alerte telle que le serveur la conserve : celles qui ont sonne comme
// celles qu'il a volontairement retenues.
// Un enregistrement tel que le serveur le conserve.
export type VideoServeur = { nom: string; mo: number; url: string };

export type AlerteHisto = {
  ts: number;
  type: string;
  capteurs?: string[];
  categorie: string;
  phrase?: string | null;
  notifiee: boolean;
  photo?: string | null;
};
