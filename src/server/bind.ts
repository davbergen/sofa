// The Sofa server is a local web app. Binding loopback keeps the API off the LAN
// so an upcoming filesystem-browse endpoint can't be reached from other hosts.
export const BIND_HOST = '127.0.0.1';
