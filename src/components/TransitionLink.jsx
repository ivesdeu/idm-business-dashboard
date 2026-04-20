import { Link } from "react-router-dom";

/** Router link: plain SPA navigation (no view-transition snapshot). */
export default function TransitionLink(props) {
  return <Link {...props} />;
}
